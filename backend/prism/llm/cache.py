"""Disk cache for LLM responses. In replay mode a cache miss is an error (no network)."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path


class ReplayMiss(RuntimeError):
    """Raised in replay mode when a request has no cached response."""


class LLMCache:
    def __init__(self, root: Path, replay: bool = False):
        self.root = Path(root)
        self.replay = replay

    @staticmethod
    def key(payload: dict) -> str:
        blob = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()

    def _path(self, key: str) -> Path:
        return self.root / key[:2] / f"{key}.json"

    def get(self, key: str) -> dict | None:
        path = self._path(key)
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
        if self.replay:
            raise ReplayMiss(f"no cached LLM response for {key}")
        return None

    def put(self, key: str, value: dict) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(value, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")
        os.replace(tmp, path)
