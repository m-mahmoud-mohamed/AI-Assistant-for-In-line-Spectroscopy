"""Load and validate the knowledge base: cards, graph, lexicon, rule metadata and page texts."""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

import yaml
from rapidfuzz import fuzz

from prism.kb.ingest import normalise
from prism.schemas import Card
from prism.units import Range


class KBError(ValueError):
    """The knowledge base is inconsistent (bad quote, duplicate id, dangling reference)."""


@dataclass
class KnowledgeBase:
    root: Path
    cards: dict[str, Card]
    methods: dict[str, dict]
    techniques: dict[str, dict]
    fibers: dict[str, dict]
    applications: list[dict]
    lexicon: dict
    rules_meta: dict[str, dict]
    version: str

    def card(self, card_id: str) -> Card:
        return self.cards[card_id]

    def cards_for(self, ids) -> list[Card]:
        return [self.cards[i] for i in dict.fromkeys(ids) if i in self.cards]

    def method_range(self, method: str) -> Range:
        lo, hi = self.methods[method]["range_um"]
        return Range(float(lo), float(hi))

    def fiber_range(self, fiber_id: str) -> Range:
        lo, hi = self.fibers[fiber_id]["range_um"]
        return Range(float(lo), float(hi))


def page_text(root: Path, source: str, page: int) -> str:
    parts = []
    for suffix in (".txt", ".md"):
        p = Path(root) / "pages" / source / f"p{page:02d}{suffix}"
        if p.exists():
            parts.append(p.read_text(encoding="utf-8"))
    return "\n".join(parts)


def quote_found(quote: str, text: str, threshold: float = 95.0) -> bool:
    q, t = normalise(quote).casefold(), normalise(text).casefold()
    if not q:
        return False
    return q in t or fuzz.partial_ratio(q, t) >= threshold


def _yaml(path: Path):
    return yaml.safe_load(path.read_text(encoding="utf-8")) if path.exists() else None


def _hash_tree(root: Path) -> str:
    h = hashlib.sha256()
    files = sorted([*root.glob("cards/*.yaml"), *root.glob("graph/*.yaml"), *root.glob("pages/*/p*.*"),
                    root / "lexicon.yaml", root / "rules.yaml", root / "ontology.yaml"])
    for f in files:
        if f.exists():
            h.update(f.relative_to(root).as_posix().encode())
            h.update(f.read_bytes())
    return h.hexdigest()[:16]


def load_kb(root: Path = Path("kb"), statuses: tuple[str, ...] = ("seed", "accepted"),
            check_quotes: bool = True) -> KnowledgeBase:
    root = Path(root)
    techniques = {t["id"]: t for t in (_yaml(root / "graph" / "techniques.yaml") or [])}
    cards: dict[str, Card] = {}
    seen: set[str] = set()
    for f in sorted((root / "cards").glob("*.yaml")):      # drafts live in kb/cards/drafts/ and are not loaded
        for raw in _yaml(f) or []:
            card = Card(**raw)
            if card.id in seen:
                raise KBError(f"duplicate card id {card.id} in {f.name}")
            seen.add(card.id)
            if card.status in statuses:
                cards[card.id] = card
    if check_quotes:
        rows = [t["table_row"] for t in techniques.values()]
        for c in cards.values():
            if c.source == "EXT":
                if not (c.url and c.retrieved_at):
                    raise KBError(f"{c.id}: external cards need url and retrieved_at")
            elif c.source == "TABLE":
                if c.quote not in rows:
                    raise KBError(f"{c.id}: quote is not a row of S01 Table 1")
            elif not quote_found(c.quote, page_text(root, c.source, c.page)):
                raise KBError(f"{c.id}: quote not found on {c.source} p.{c.page}")
    methods = {m["id"]: m for m in _yaml(root / "graph" / "methods.yaml")}
    fibers = {f["id"]: f for f in _yaml(root / "graph" / "fibers.yaml")}
    applications = _yaml(root / "graph" / "applications.yaml") or []
    rules_meta = {r["id"]: r for r in (_yaml(root / "rules.yaml") or [])}
    refs = [(f"method {m['id']}", cid) for m in methods.values()
            for key in ("range_cards", "limitation_cards", "general_cards") for cid in m.get(key, [])]
    refs += [(f"fiber {f['id']}", f["card"]) for f in fibers.values()]
    refs += [(f"application {a['id']}", cid) for a in applications for cid in a["cards"]]
    refs += [(f"rule {r['id']}", cid) for r in rules_meta.values() for cid in r.get("sources", [])]
    missing = sorted({f"{owner} → {cid}" for owner, cid in refs if cid not in cards})
    missing += sorted({f"application {a['id']} → technique {t}" for a in applications
                       for t in a.get("techniques", []) if t not in techniques})
    if missing:
        raise KBError("dangling references: " + "; ".join(missing))
    return KnowledgeBase(root=root, cards=cards, methods=methods, techniques=techniques, fibers=fibers,
                         applications=applications, lexicon=_yaml(root / "lexicon.yaml") or {},
                         rules_meta=rules_meta, version=_hash_tree(root))
