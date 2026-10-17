"""Draft evidence cards from page texts with the generator role. Drafts need domain-expert review."""
from __future__ import annotations

import argparse
from pathlib import Path

import yaml
from pydantic import BaseModel

from prism.kb.loader import page_text, quote_found
from prism.llm.prompts import render
from prism.schemas import Scope


class CardDraft(BaseModel):
    quote: str
    claim: str
    scope: Scope
    methods: list[str]
    topics: list[str]


class CardDraftList(BaseModel):
    cards: list[CardDraft]


def draft_cards(gateway, kb_root: Path, source: str, pages: list[int], max_per_page: int = 6) -> Path:
    out = []
    for p in pages:
        text = page_text(kb_root, source, p)
        prompt, _ = render("card_draft.j2", source=source, page=p, text=text, max_cards=max_per_page)
        res = gateway.complete("generator", [{"role": "user", "content": prompt}], schema=CardDraftList,
                               reasoning="off")
        kept = [d for d in res.parsed.cards[:max_per_page] if quote_found(d.quote, text)]
        for k, d in enumerate(kept, start=1):
            out.append({"id": f"{source}-p{p:02d}-d{k}", "source": source, "page": p,
                        **d.model_dump(mode="json"), "status": "draft"})
    path = Path(kb_root) / "cards" / "drafts" / f"{source}-p{pages[0]:02d}-p{pages[-1]:02d}.yaml"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(out, sort_keys=False, allow_unicode=True, width=120), encoding="utf-8")
    return path


if __name__ == "__main__":
    from prism.llm.gateway import build_gateway
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("pages", type=int, nargs="+")
    a = ap.parse_args()
    print(draft_cards(build_gateway(), Path("kb"), a.source, a.pages))
