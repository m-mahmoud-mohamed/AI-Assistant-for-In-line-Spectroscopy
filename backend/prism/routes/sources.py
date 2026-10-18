"""Source collections, bounded multipart imports, jobs and document management."""
from __future__ import annotations

import json
import threading
from contextlib import asynccontextmanager
from typing import Annotated, Literal

from fastapi import APIRouter, File, Form, HTTPException, Query, Request, UploadFile

from prism.sources.extraction import skip_reason
from prism.sources.models import (
    DEFAULT_COLLECTION,
    MAX_BATCH,
    MAX_BATCH_BYTES,
    MAX_FILE_BYTES,
    CollectionInput,
    UrlInput,
)
from prism.sources.service import SourceService
from prism.sources.storage import SourceStore

router = APIRouter(prefix="/api/sources", tags=["sources"])
_lock = threading.Lock()


@asynccontextmanager
async def lifespan(app):
    try:
        yield
    finally:
        if hasattr(app.state, "sources"):
            app.state.sources.close()


def service_for(request: Request) -> SourceService:
    with _lock:
        state = request.app.state
        if not hasattr(state, "sources"):
            state.sources = SourceService(SourceStore(state.store.db_path), state.gateway)
        return state.sources


def call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except KeyError:
        raise HTTPException(404, "Source, collection or job does not exist") from None
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None


@router.get("/collections")
def collections(request: Request):
    return service_for(request).collections()


@router.post("/collections", status_code=201)
def create_collection(request: Request, body: CollectionInput):
    return call(service_for(request).collection, body.name)


@router.patch("/collections/{cid}")
def rename_collection(cid: str, request: Request, body: CollectionInput):
    return call(service_for(request).collection, body.name, cid)


@router.delete("/collections/{cid}", status_code=204)
def delete_collection(cid: str, request: Request):
    call(service_for(request).delete_collection, cid)


@router.post("/upload", status_code=202)
async def upload(request: Request, files: Annotated[list[UploadFile], File()],
                 collection: str = Form(DEFAULT_COLLECTION), relative_paths: str = Form("[]")):
    service = service_for(request)
    try:
        call(service.require_collection, collection)
        if not 1 <= len(files) <= MAX_BATCH:
            raise HTTPException(413, f"Upload 1–{MAX_BATCH} files per batch")
        try:
            paths = json.loads(relative_paths)
            if (not isinstance(paths, list) or paths and len(paths) != len(files)
                    or any(not isinstance(p, str) for p in paths)):
                raise ValueError
        except (ValueError, TypeError):
            raise HTTPException(422, "relative_paths must be a JSON list with one path per file") from None
        jobs, skipped, total = [], [], 0
        for i, file in enumerate(files):
            name = paths[i] if paths else file.filename or "untitled"
            reason = skip_reason(name)
            if reason:
                skipped.append({"path": name, "reason": reason})
                continue
            # Read at most one byte beyond the limit, never an unbounded file.read().
            content = await file.read(MAX_FILE_BYTES + 1)
            total += len(content)
            if total > MAX_BATCH_BYTES:
                jobs.append(service.failure(name, "Batch exceeds 200 MB; upload remaining files in another batch"))
                continue
            try:
                jobs.append(service.upload(collection, name.rsplit("/", 1)[-1], content, name))
            except ValueError as exc:
                jobs.append(service.failure(name, str(exc)))
        return {"jobs": jobs, "skipped": skipped}
    finally:
        for file in files:
            await file.close()


@router.post("/urls", status_code=202)
def urls(request: Request, body: UrlInput):
    return {"jobs": call(service_for(request).urls, body.collection, body.urls)}


@router.get("/jobs/{jid}")
def job(jid: str, request: Request):
    return call(service_for(request).job, jid)


@router.get("/sources")
def sources(request: Request, collection: str | None = None, limit: int = Query(50, ge=1, le=100),
            offset: int = Query(0, ge=0),
            status: Literal["queued", "extracting", "chunking", "indexing", "ready", "failed"] | None = None,
            kind: Literal["UPLOAD", "WEB", "MCP"] | None = None):
    return service_for(request).list(collection, limit, offset, status, kind)


@router.post("/reindex", status_code=202)
def reindex_all(request: Request):
    service = service_for(request)
    with service.store.db() as db:
        ids = [r[0] for r in db.execute("SELECT id FROM sources")]
    return {"jobs": [service.reindex(sid) for sid in ids]}


@router.get("/sources/{sid}")
def source(sid: str, request: Request):
    return call(service_for(request).detail, sid)


@router.delete("/sources/{sid}", status_code=204)
def delete_source(sid: str, request: Request):
    call(service_for(request).delete, sid)


@router.post("/sources/{sid}/reindex", status_code=202)
def reindex(sid: str, request: Request):
    return call(service_for(request).reindex, sid)
