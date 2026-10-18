"""Source tables share prism.db; original bytes live under data/sources with opaque names."""
from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS source_collections (id TEXT PRIMARY KEY, name TEXT NOT NULL, added_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources (
 id TEXT PRIMARY KEY, collection TEXT NOT NULL REFERENCES source_collections(id), title TEXT NOT NULL,
 kind TEXT NOT NULL, filename TEXT NOT NULL, relative_path TEXT NOT NULL, mime TEXT NOT NULL,
 size INTEGER NOT NULL, sha256 TEXT NOT NULL UNIQUE, canonical_url TEXT UNIQUE, origin TEXT NOT NULL,
 pages TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', added_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS sources_collection ON sources(collection);
CREATE TABLE IF NOT EXISTS source_chunks (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
 page INTEGER NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, text TEXT NOT NULL, sha256 TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS source_chunks_source ON source_chunks(source_id);
CREATE TABLE IF NOT EXISTS source_embeddings (
 chunk_id TEXT NOT NULL REFERENCES source_chunks(id) ON DELETE CASCADE, embedder TEXT NOT NULL,
 vector TEXT NOT NULL, PRIMARY KEY(chunk_id, embedder));
CREATE TABLE IF NOT EXISTS source_jobs (
 id TEXT PRIMARY KEY, source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
 title TEXT NOT NULL, status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0,
 error TEXT NOT NULL DEFAULT '', duplicate INTEGER NOT NULL DEFAULT 0, added_at TEXT NOT NULL, updated_at TEXT NOT NULL);
"""


class SourceStore:
    def __init__(self, db_path: Path = Path("data/prism.db"), files: Path | None = None):
        self.db_path = Path(db_path)
        self.files = Path(files) if files else self.db_path.parent / "sources"
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.files.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        with self.db() as db:
            db.executescript(SCHEMA)
            db.execute("INSERT OR IGNORE INTO source_collections VALUES ('default', 'General', datetime('now'))")

    @contextmanager
    def db(self):
        with self.lock:
            conn = sqlite3.connect(self.db_path, timeout=30)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys=ON")
            try:
                with conn:
                    yield conn
            finally:
                conn.close()

    def blob(self, source_id: str) -> Path:
        # IDs are generated internally, never filenames/paths supplied by users.
        if len(source_id) != 32 or any(c not in "0123456789abcdef" for c in source_id):
            raise ValueError("Invalid source ID")
        return self.files / source_id
