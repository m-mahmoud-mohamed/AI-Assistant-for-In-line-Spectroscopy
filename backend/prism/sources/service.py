"""Source lifecycle and background ingestion, independent of FastAPI and model providers."""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit

from prism.schemas import Card
from prism.sources.chunking import chunks
from prism.sources.extraction import MIMES, document_title, extract, validate_file
from prism.sources.indexing import SEMANTIC_PENDING, embedder_tag, vectors
from prism.sources.models import DEFAULT_COLLECTION
from prism.sources.storage import SourceStore
from prism.sources.urls import SourceHttp, canonical_url
from prism.web.http import now_iso


class SourceService:
    def __init__(self, store: SourceStore | None = None, gateway=None, http=None):
        self.store = store or SourceStore(Path(os.environ.get("PRISM_SOURCES_DB", "data/prism.db")))
        self.gateway, self.http = gateway, http
        self._executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="source-ingest")
        self._lock = threading.RLock()
        self._active: set[str] = set()
        # A new service represents a new process: interrupted jobs have a clear, recoverable status.
        with self.store.db() as db:
            db.execute("UPDATE source_jobs SET status='failed', error='Import interrupted; re-index to retry', "
                       "updated_at=? WHERE status NOT IN ('ready','failed')", (now_iso(),))
            db.execute("UPDATE sources SET status='failed', error='Import interrupted; re-index to retry' "
                       "WHERE status NOT IN ('ready','failed')")

    def close(self):
        self._executor.shutdown(wait=True, cancel_futures=False)
        if self.http:
            self.http.close()

    def collections(self) -> list[dict]:
        with self.store.db() as db:
            return [dict(r) for r in db.execute(
                "SELECT c.*, count(s.id) AS sources FROM source_collections c LEFT JOIN sources s "
                "ON s.collection=c.id GROUP BY c.id ORDER BY c.added_at, c.id")]

    def collection(self, name: str, collection_id: str | None = None) -> dict:
        name = name.strip()
        if not name or len(name) > 120:
            raise ValueError("Collection name must be 1–120 characters")
        cid = collection_id or uuid.uuid4().hex
        with self.store.db() as db:
            if collection_id:
                if not db.execute("UPDATE source_collections SET name=? WHERE id=?", (name, cid)).rowcount:
                    raise KeyError(cid)
            else:
                db.execute("INSERT INTO source_collections VALUES (?, ?, ?)", (cid, name, now_iso()))
        return next(c for c in self.collections() if c["id"] == cid)

    def delete_collection(self, cid: str):
        if cid == DEFAULT_COLLECTION:
            raise ValueError("The General collection cannot be deleted")
        with self.store.db() as db:
            if not db.execute("SELECT 1 FROM source_collections WHERE id=?", (cid,)).fetchone():
                raise KeyError(cid)
            db.execute("UPDATE sources SET collection=? WHERE collection=?", (DEFAULT_COLLECTION, cid))
            db.execute("DELETE FROM source_collections WHERE id=?", (cid,))

    def require_collection(self, cid: str):
        with self.store.db() as db:
            if not db.execute("SELECT 1 FROM source_collections WHERE id=?", (cid,)).fetchone():
                raise KeyError(cid)

    def _new_job(self, title: str, sid=None, duplicate=False, error="") -> dict:
        jid, now = uuid.uuid4().hex, now_iso()
        status = "failed" if error else "ready" if duplicate else "queued"
        with self.store.db() as db:
            db.execute("INSERT INTO source_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                       (jid, sid, title[:500], status, 100 if duplicate else 0, error, duplicate, now, now))
        return self.job(jid)

    def failure(self, title: str, error: str) -> dict:
        return self._new_job(title, error=error)

    def job(self, jid: str) -> dict:
        with self.store.db() as db:
            row = db.execute("SELECT * FROM source_jobs WHERE id=?", (jid,)).fetchone()
        if row is None:
            raise KeyError(jid)
        return {**dict(row), "duplicate": bool(row["duplicate"])}

    def _stage(self, jid: str, status: str, progress: int, error=""):
        with self.store.db() as db:
            job = db.execute("SELECT source_id FROM source_jobs WHERE id=?", (jid,)).fetchone()
            db.execute("UPDATE source_jobs SET status=?, progress=?, error=?, updated_at=? WHERE id=?",
                       (status, progress, error, now_iso(), jid))
            if job:
                db.execute("UPDATE sources SET status=?, error=? WHERE id=?", (status, error, job["source_id"]))

    def _schedule(self, job: dict, fn):
        with self._lock:
            self._active.add(job["id"])
        def run():
            try:
                fn()
            except Exception:  # noqa: BLE001 - a failed worker must finish its persisted job
                # Worker errors must be visible, but parser/provider internals can contain sensitive data.
                self._stage(job["id"], "failed", 0, "Import failed; check the document and retry re-indexing")
            finally:
                with self._lock:
                    self._active.discard(job["id"])
        self._executor.submit(run)

    def upload(self, collection: str, title: str, content: bytes, filename: str,
               origin: dict | None = None, background=True) -> dict:
        self.require_collection(collection)
        path, mime = validate_file(filename, content)
        sha = hashlib.sha256(content).hexdigest()
        origin = dict(origin or {"kind": "upload", "filename": path})
        kind = {"upload": "UPLOAD", "web": "WEB", "mcp": "MCP"}.get(origin.get("kind"))
        if not kind:
            raise ValueError("Unsupported source origin")
        canonical = canonical_url(origin["url"]) if kind == "WEB" else None
        sid = uuid.uuid4().hex
        with self.store.db() as db:
            existing = db.execute("SELECT id FROM sources WHERE sha256=? OR canonical_url=?", (sha, canonical)).fetchone()
            if existing:
                return self._new_job(title, existing["id"], duplicate=True)
            # Reserve the unique hash before processing, so concurrent batches cannot duplicate content.
            try:
                db.execute("INSERT INTO sources (id, collection, title, kind, filename, relative_path, mime, size, "
                           "sha256, canonical_url, origin, status, added_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                           (sid, collection, title[:500] or Path(path).name, kind, Path(path).name, path, mime,
                            len(content), sha, canonical, json.dumps(origin), "queued", now_iso()))
            except sqlite3.IntegrityError as exc:
                raise ValueError("Source already exists or collection was deleted") from exc
        try:
            self.store.blob(sid).write_bytes(content)
        except OSError:
            with self.store.db() as db:
                db.execute("DELETE FROM sources WHERE id=?", (sid,))
            raise
        job = self._new_job(title, sid)
        if background:
            self._schedule(job, lambda: self._process(job["id"], sid))
        else:
            self._process(job["id"], sid)
        return self.job(job["id"])

    def _process(self, jid: str, sid: str):
        try:
            self._stage(jid, "extracting", 20)
            source = self.detail(sid)
            pages, title = extract(self.store.blob(sid).read_bytes(), source["mime"])
            self._stage(jid, "chunking", 50)
            rows = chunks(sid, pages)
            with self.store.db() as db:
                if not db.execute("SELECT 1 FROM sources WHERE id=?", (sid,)).fetchone():
                    raise ValueError("Source was deleted")
                db.execute("DELETE FROM source_chunks WHERE source_id=?", (sid,))
                db.executemany("INSERT INTO source_chunks VALUES (:id,:source_id,:page,:start,:end,:text,:sha256)", rows)
                # A connector names its resource; for files and websites the document's own title is better.
                keep = source["origin"].get("kind") == "mcp"
                db.execute("UPDATE sources SET pages=?, title=? WHERE id=?",
                           (json.dumps(pages), source["title"] if keep else document_title(
                               title, Path(source["filename"]).stem if source["kind"] == "UPLOAD" else source["title"]), sid))
            self._stage(jid, "indexing", 75)
            indexed = vectors(self.store, self.cards(sid, ready_only=False), self.gateway, embedder_tag(self.gateway))
            self._stage(jid, "ready", 100, SEMANTIC_PENDING if indexed is None else "")
        except (ValueError, KeyError) as exc:
            message = str(exc) if isinstance(exc, ValueError) else "Source was deleted"
            self._stage(jid, "failed", 0, message)

    def urls(self, collection: str, urls: list[str]) -> list[dict]:
        self.require_collection(collection)
        jobs = []
        for url in urls:
            try:
                canonical = canonical_url(url)
            except ValueError as exc:
                jobs.append(self.failure(url, str(exc)))
                continue
            with self.store.db() as db:
                exists = db.execute("SELECT id FROM sources WHERE canonical_url=?", (canonical,)).fetchone()
            if exists:
                jobs.append(self._new_job(canonical, exists["id"], duplicate=True))
                continue
            job = self._new_job(canonical)
            self._schedule(job, lambda u=canonical, j=job["id"]: self._fetch(j, collection, u))
            jobs.append(job)
        return jobs

    def _fetch(self, jid: str, collection: str, url: str):
        self._stage(jid, "extracting", 10)
        http = self.http or SourceHttp()
        try:
            response = http.get(url, page=True)
            if not response.ok or response.content_type not in ("text/html", "application/xhtml+xml", "application/pdf",
                                                                "text/plain", "text/markdown"):
                self._stage(jid, "failed", 0, f"URL could not be imported ({response.error or 'unsupported content type'})")
                return
            suffix = {"application/pdf": ".pdf", "text/plain": ".txt", "text/markdown": ".md"}.get(
                response.content_type, ".html")
            final = canonical_url(response.url or url)
            imported = self.upload(collection, urlsplit(url).hostname, response.body, "website" + suffix,
                                   {"kind": "web", "url": url, "final_url": final,
                                    "retrieved_at": response.retrieved_at or now_iso()}, background=False)
            with self.store.db() as db:
                db.execute("UPDATE source_jobs SET source_id=?, duplicate=? WHERE id=?",
                           (imported["source_id"], imported["duplicate"], jid))
            self._stage(jid, imported["status"], imported["progress"], imported["error"])
        finally:
            if self.http is None:
                http.close()

    def list(self, collection: str | None = None, limit=50, offset=0, status=None, kind=None) -> dict:
        filters = {"collection": collection, "status": status, "kind": kind}
        clauses = [f"s.{key}=?" for key, value in filters.items() if value is not None]
        params = [value for value in filters.values() if value is not None]
        where = "WHERE " + " AND ".join(clauses) if clauses else ""
        with self.store.db() as db:
            total = db.execute(f"SELECT count(*) FROM sources s {where}", params).fetchone()[0]
            rows = db.execute(f"SELECT s.*, (SELECT count(*) FROM source_chunks c WHERE c.source_id=s.id) "
                              f"AS chunks FROM sources s {where} ORDER BY added_at DESC, id LIMIT ? OFFSET ?",
                              [*params, limit, offset]).fetchall()
        return {"items": [self._metadata(r) for r in rows], "total": total, "limit": limit, "offset": offset}

    @staticmethod
    def _metadata(row) -> dict:
        data = dict(row)
        pages = json.loads(data.pop("pages"))
        data["pages"] = len(pages)
        data["origin"] = json.loads(data["origin"])
        return data

    def detail(self, sid: str) -> dict:
        with self.store.db() as db:
            row = db.execute("SELECT s.*, (SELECT count(*) FROM source_chunks c WHERE c.source_id=s.id) AS chunks "
                             "FROM sources s WHERE id=?", (sid,)).fetchone()
        if row is None:
            raise KeyError(sid)
        pages = json.loads(row["pages"])
        return {**self._metadata(row), "preview": [{"page": p["page"], "text": p["text"][:5000],
                                                  "truncated": len(p["text"]) > 5000} for p in pages[:100]],
                "preview_truncated": len(pages) > 100}

    def delete(self, sid: str):
        with self.store.db() as db:
            if not db.execute("DELETE FROM sources WHERE id=?", (sid,)).rowcount:
                raise KeyError(sid)
        self.store.blob(sid).unlink(missing_ok=True)

    def reindex(self, sid: str) -> dict:
        source = self.detail(sid)
        with self.store.db() as db:
            active = db.execute("SELECT id FROM source_jobs WHERE source_id=? AND status NOT IN ('ready','failed')",
                                (sid,)).fetchone()
            if active:
                return self.job(active["id"])
        job = self._new_job(source["title"], sid)
        self._schedule(job, lambda: self._process(job["id"], sid))
        return job

    def cards(self, sid: str | None = None, ready_only=True) -> list[Card]:
        where = " WHERE s.status='ready'" if ready_only else " WHERE 1=1"
        if sid:
            where += " AND s.id=?"
        with self.store.db() as db:
            rows = db.execute("SELECT c.*, s.collection, s.title, s.kind, s.origin, s.sha256 AS content_sha256 "
                              "FROM source_chunks c JOIN sources s ON s.id=c.source_id" + where,
                              (sid,) if sid else ()).fetchall()
        cards = []
        for row in rows:
            origin = json.loads(row["origin"])
            cards.append(Card(id=f"{row['kind']}-{row['id']}", source=row["kind"], title=row["title"],
                              page=row["page"], quote=row["text"], claim=row["text"], scope="external", status="accepted",
                              url=origin.get("url"), retrieved_at=origin.get("retrieved_at"),
                              provenance={**origin, "source_id": row["source_id"], "collection": row["collection"],
                                          "chunk_id": row["id"], "char_start": row["start"], "char_end": row["end"],
                                          "sha256": row["sha256"], "content_sha256": row["content_sha256"]}))
        return cards


_default: SourceService | None = None
_default_lock = threading.Lock()


def default_service() -> SourceService:
    global _default
    with _default_lock:
        if _default is None:
            _default = SourceService()
        return _default


def set_default_service(service: SourceService) -> None:
    """The API registers its service, so connector imports land in the database the app serves."""
    global _default
    with _default_lock:
        _default = service


def import_document(collection: str, title: str, content: bytes, mime: str, origin: dict) -> dict:
    """Connector contract. Import synchronously; return job/source IDs, status and duplicate information.

    `collection` is a collection ID. MCP provenance must identify its server, resource URI and retrieval time.
    """
    if (origin.get("kind") != "mcp" or not origin.get("server")
            or not (origin.get("uri") or origin.get("resource_uri")) or not origin.get("retrieved_at")):
        raise ValueError("MCP origin requires kind=mcp, server, uri (or resource_uri), retrieved_at")
    suffix = next((ext for ext, media in MIMES.items() if media == mime.split(";")[0].strip()), None)
    if suffix is None:
        raise ValueError("Unsupported document MIME type")
    return default_service().upload(collection, title, content, "resource" + suffix, origin, background=False)
