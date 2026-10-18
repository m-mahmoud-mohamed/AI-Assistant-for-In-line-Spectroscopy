"""Disk cache for LLM responses. In replay mode a cache miss is an error (no network).

Thread-safe: writes go to a unique temporary file and are moved into place atomically, so a reader (or a second
writer of the same key) never sees a partial file."""
from __future__ import annotations

import hashlib
import json
import os
import threading
import uuid
from pathlib import Path


class ReplayMiss(RuntimeError):
    """Raised in replay mode when a request has no cached response."""


class LLMCache:
    def __init__(self, root: Path, replay: bool = False):
        self.root = Path(root)
        self.replay = replay
        self._lock = threading.Lock()
        self._stats = {"hits": 0, "misses": 0, "writes": 0}

    @staticmethod
    def key(payload: dict) -> str:
        blob = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()

    def _path(self, key: str) -> Path:
        return self.root / key[:2] / f"{key}.json"

    def _count(self, name: str) -> None:
        with self._lock:
            self._stats[name] += 1

    def get(self, key: str) -> dict | None:
        path = self._path(key)
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            value = None
        except ValueError:                      # unreadable entry (interrupted copy, manual edit): treat as a miss
            value = None
        if value is not None:
            self._count("hits")
            return value
        self._count("misses")
        if self.replay:
            raise ReplayMiss(f"no cached LLM response for {key}")
        return None

    def put(self, key: str, value: dict) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.{uuid.uuid4().hex[:8]}.tmp")
        try:
            tmp.write_text(json.dumps(value, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")
            os.replace(tmp, path)
        finally:
            tmp.unlink(missing_ok=True)
        self._count("writes")

    def stats(self) -> dict[str, int]:
        with self._lock:
            return dict(self._stats)
