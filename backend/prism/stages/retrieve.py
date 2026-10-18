"""Stage 3: graph-first evidence selection plus BM25/embedding recall, fused by reciprocal rank."""
from __future__ import annotations

import hashlib
import logging
import os
import re
from pathlib import Path

import numpy as np
from rank_bm25 import BM25Okapi

from prism.kb.loader import KnowledgeBase, refresh_imported
from prism.rules.physics import fiber_family_of
from prism.schemas import EvidencePack, RequirementsSheet, RuleFindings

log = logging.getLogger(__name__)

_SERVICE = re.compile(r"service|offer|feasibility test|test your process|afs lab", re.IGNORECASE)


def rrf(rankings: list[list[str]], k: int = 60) -> list[str]:
    scores: dict[str, float] = {}
    for ranking in rankings:
        for rank, item in enumerate(ranking):
            scores[item] = scores.get(item, 0.0) + 1.0 / (k + rank + 1)
    return sorted(scores, key=lambda i: (-scores[i], i))


def sheet_query(sheet: RequirementsSheet) -> str:
    parts = [sheet.domain]
    for s in sheet.streams:
        parts += [t.name for t in s.targets] + [s.matrix.value, s.optics.value]
    parts += [p.text for p in sheet.premises] + [a.description for a in sheet.existing_assets]
    parts += [i.canonical or i.term for i in sheet.interpretations]
    parts += [sheet.process_conditions.value] if sheet.process_conditions.stated else []
    return " ".join(p for p in parts if p and p != "unknown")


def _tokens(text: str) -> list[str]:
    return re.findall(r"[a-z0-9µ⁻-]+", text.lower())


class Retriever:
    def __init__(self, kb: KnowledgeBase, gateway=None, index_dir: Path | None = None):
        # PRISM_INDEX_DIR points the embedding index at a writable place when kb/ is read-only (Docker).
        index_dir = index_dir or os.environ.get("PRISM_INDEX_DIR", "kb/.index")
        self.kb, self.gateway, self.index_dir = kb, gateway, Path(index_dir)
        refresh_imported(kb)
        self._version = kb.version
        self.ids = sorted(kb.cards)
        self.texts = [f"{c.claim} {c.quote} {' '.join(c.topics)} {' '.join(c.methods)}"
                      for c in (kb.cards[i] for i in self.ids)]
        self.bm25 = BM25Okapi([_tokens(t) for t in self.texts])
        self._vectors: np.ndarray | None = None

    def _refresh(self):
        refresh_imported(self.kb)
        if self._version != self.kb.version:
            self.__init__(self.kb, self.gateway, self.index_dir)

    def _dense(self) -> np.ndarray | None:
        if self.gateway is None:
            return None
        if self._vectors is None and self.kb.imported_sources is not None:
            from prism.sources.indexing import vectors
            curated = [i for i in self.ids if not self.kb.cards[i].provenance.get("chunk_id")]
            imported = [self.kb.cards[i] for i in self.ids if self.kb.cards[i].provenance.get("chunk_id")]
            # The curated cache key remains stable when imported documents change.
            from dataclasses import replace
            base = replace(self.kb, cards={i: self.kb.cards[i] for i in curated}, imported_sources=None,
                           version=self.kb.curated_version or self.kb.version)
            dense = Retriever(base, self.gateway, self.index_dir)._dense()
            extra = vectors(self.kb.imported_sources.store, imported, self.gateway, self._embedder_tag()) if imported else []
            if dense is None or extra is None:
                return None
            by_id = dict(zip(curated, dense.tolist()))
            by_id.update({c.id: v for c, v in zip(imported, extra)})
            try:
                self._vectors = np.asarray([by_id[i] for i in self.ids], dtype=np.float32)
            except ValueError:  # a provider fallback changed vector dimensions: BM25 remains available
                return None
        if self._vectors is None:
            path = self.index_dir / f"{self.kb.version}-{self._embedder_tag()}.npy"
            if path.exists():
                self._vectors = np.load(path)
            else:
                rows: list[list[float]] = []
                for i in range(0, len(self.texts), 64):
                    batch = self.gateway.embed(self.texts[i:i + 64])
                    if batch is None:
                        return None
                    rows += batch
                self._vectors = np.asarray(rows, dtype=np.float32)
                try:
                    self.index_dir.mkdir(parents=True, exist_ok=True)
                    np.save(path, self._vectors)
                except OSError as exc:  # unwritable index dir: keep the vectors in memory for this process
                    log.warning("embedding index not saved to %s: %s", self.index_dir, exc)
        return self._vectors

    def _embedder_tag(self) -> str:
        """The index belongs to one embedder: vectors of another profile or model have another size and meaning."""
        profile = getattr(self.gateway, "profile", None)
        rc = getattr(profile, "roles", {}).get("embedder") if profile is not None else None
        name = f"{getattr(profile, 'name', '')}|{','.join(rc.models) if rc else ''}"
        return hashlib.sha256(name.encode()).hexdigest()[:8]

    def search(self, query: str, k: int = 8) -> list[str]:
        self._refresh()
        scores = self.bm25.get_scores(_tokens(query))
        rankings = [[self.ids[i] for i in np.argsort(-scores)[:k * 3]]]
        dense = self._dense()
        if dense is not None:
            q = self.gateway.embed([query])
            if q:
                qv = np.asarray(q[0], dtype=np.float32)
                if qv.shape[0] != dense.shape[1]:   # the query came from a fallback embedder: BM25 alone
                    log.warning("query embedding has %d dims, the index %d; dense recall skipped",
                                qv.shape[0], dense.shape[1])
                    return rrf(rankings)[:k]
                sims = dense @ qv / (np.linalg.norm(dense, axis=1) * np.linalg.norm(qv) + 1e-9)
                rankings.append([self.ids[i] for i in np.argsort(-sims)[:k * 3]])
        return rrf(rankings)[:k]

    def mandatory(self, sheet: RequirementsSheet, findings: RuleFindings) -> dict[str, str]:
        out: dict[str, str] = {}
        for f in findings.findings:
            for cid in f.evidence_ids:
                out.setdefault(cid, f"rule {f.rule_id}")
        shown = [c for s in sheet.streams for c in findings.top(s.id, 3)]
        shown += [c for c in findings.candidates if c.blocked][:4]
        for c in shown:
            m = self.kb.methods[c.method]
            for cid in m.get("range_cards", []):
                out.setdefault(cid, f"method range {c.method}")
            for cid in [*m.get("limitation_cards", []), *m.get("general_cards", [])]:
                out.setdefault(cid, f"method {c.method}")
            for cid in c.evidence_ids:
                out.setdefault(cid, f"candidate {c.key}")
        for a in sheet.existing_assets:
            if a.kind == "fiber" and (fam := fiber_family_of(a, self.kb)):
                out.setdefault(self.kb.fibers[fam]["card"], "client fiber")
        return {cid: why for cid, why in out.items() if cid in self.kb.cards}

    def pack(self, sheet: RequirementsSheet, findings: RuleFindings, k_extra: int = 8,
             max_cards: int = 40) -> EvidencePack:
        self._refresh()
        reasons = self.mandatory(sheet, findings)
        query = sheet_query(sheet)
        for cid in self.search(query, k=k_extra * 2):
            if len(reasons) >= max_cards:
                break
            card = self.kb.cards[cid]
            if card.scope.value == "business_context" and not _SERVICE.search(query):
                continue
            reasons.setdefault(cid, "search")
        ids = list(reasons)[:max_cards]
        return EvidencePack(cards=self.kb.cards_for(ids), reasons={i: reasons[i] for i in ids})
