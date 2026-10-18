"""Incremental per-chunk embeddings, namespaced by the selected embedder. BM25 uses stored chunks."""
from __future__ import annotations

import hashlib
import json

SEMANTIC_PENDING = "Semantic index pending: the embedding service was unavailable"


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
        try:
            result = gateway.embed([f"{c.claim} {c.quote} {' '.join(c.topics)} {' '.join(c.methods)}" for c in batch])
        except Exception:  # noqa: BLE001 - optional provider failures must not block stored evidence
            return None
        if result is None or len(result) != len(batch) or any(not v for v in result):
            return None
        with store.db() as db:
            for card, vector in zip(batch, result):
                cid = card.provenance["chunk_id"]
                # A delete/re-index may have removed this chunk while the embedding was running.
                if db.execute("SELECT 1 FROM source_chunks WHERE id=?", (cid,)).fetchone():
                    db.execute("INSERT OR REPLACE INTO source_embeddings VALUES (?, ?, ?)",
                               (cid, tag, json.dumps(vector)))
                cached[cid] = vector
    # Lazy retrieval can finish a previously deferred index. Clear only our own note,
    # and only once every chunk of that source has a vector for this embedder.
    with store.db() as db:
        for sid in {c.provenance["source_id"] for c in cards}:
            missing = db.execute("SELECT 1 FROM source_chunks c WHERE c.source_id=? AND NOT EXISTS "
                                 "(SELECT 1 FROM source_embeddings e WHERE e.chunk_id=c.id AND e.embedder=?) LIMIT 1",
                                 (sid, tag)).fetchone()
            if not missing:
                db.execute("UPDATE sources SET error='' WHERE id=? AND status='ready' AND error=?",
                           (sid, SEMANTIC_PENDING))
                db.execute("UPDATE source_jobs SET error='' WHERE source_id=? AND status='ready' AND error=?",
                           (sid, SEMANTIC_PENDING))
    return [cached[c.provenance["chunk_id"]] for c in cards]
