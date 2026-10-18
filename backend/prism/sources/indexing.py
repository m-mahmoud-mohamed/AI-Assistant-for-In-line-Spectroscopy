"""Incremental per-chunk embeddings, namespaced by the selected embedder. BM25 uses stored chunks."""
from __future__ import annotations

import hashlib
import json


def embedder_tag(gateway) -> str:
    profile = getattr(gateway, "profile", None)
    role = getattr(profile, "roles", {}).get("embedder") if profile is not None else None
    name = f"{getattr(profile, 'name', '')}|{','.join(role.models) if role else ''}"
    return hashlib.sha256(name.encode()).hexdigest()[:8]


def vectors(store, cards, gateway, tag: str) -> list[list[float]] | None:
    if gateway is None or not cards:
        return None
    with store.db() as db:
        cached = {r["chunk_id"]: json.loads(r["vector"]) for r in db.execute(
            "SELECT chunk_id, vector FROM source_embeddings WHERE embedder=?", (tag,))}
    missing = [c for c in cards if c.provenance["chunk_id"] not in cached]
    for start in range(0, len(missing), 64):
        batch = missing[start:start + 64]
        result = gateway.embed([f"{c.claim} {c.quote} {' '.join(c.topics)} {' '.join(c.methods)}" for c in batch])
        if result is None:
            return None
        if len(result) != len(batch):
            raise ValueError("Embedder returned the wrong number of vectors")
        with store.db() as db:
            for card, vector in zip(batch, result):
                cid = card.provenance["chunk_id"]
                # A delete/re-index may have removed this chunk while the embedding was running.
                if db.execute("SELECT 1 FROM source_chunks WHERE id=?", (cid,)).fetchone():
                    db.execute("INSERT OR REPLACE INTO source_embeddings VALUES (?, ?, ?)",
                               (cid, tag, json.dumps(vector)))
                cached[cid] = vector
    return [cached[c.provenance["chunk_id"]] for c in cards]
