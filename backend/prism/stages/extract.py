"""Stage 1: LLM extraction of the requirements sheet, then verbatim quote grounding in code."""
from __future__ import annotations

import re
import unicodedata

from prism.llm.prompts import render
from prism.schemas import (
    ASSET_KINDS,
    CERTAINTY,
    DISTANCE,
    DOMAINS,
    MATRIX,
    METHODS,
    OPTICS,
    PREMISE_TYPES,
    USE_CONTEXT,
    Enquiry,
    Fact,
    RequirementsSheet,
)

# Typographic quotes, dashes and non-breaking spaces are folded so a quote copied with plain ASCII still matches.
_TRANSLATE = str.maketrans({"\u2019": "'", "\u2018": "'", "\u201c": '"', "\u201d": '"', "\u2013": "-",
                            "\u2014": "-", "\u00a0": " "})


def norm_text(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).translate(_TRANSLATE)
    return re.sub(r"\s+", " ", text).strip().casefold()


def grounded(quote: str | None, sources: list[str]) -> bool:
    q = norm_text(quote or "")
    return bool(q) and any(q in norm_text(s) for s in sources)


def questions_from_text(text: str) -> list[str]:
    return [q.strip() for q in re.findall(r"[^.?!\n]*\?", text) if q.strip()]


def ground_sheet(sheet: RequirementsSheet, sources: list[str]) -> tuple[RequirementsSheet, list[str]]:
    dropped: list[str] = []

    def fix(fact: Fact, name: str) -> Fact:
        if fact.value != "unknown" and not grounded(fact.quote, sources):
            dropped.append(name)
            return Fact()
        return fact

    for name in RequirementsSheet.GLOBAL_FACTS:
        setattr(sheet, name, fix(getattr(sheet, name), name))
    for s in sheet.streams:
        s.matrix = fix(s.matrix, f"streams.{s.id}.matrix")
        s.optics = fix(s.optics, f"streams.{s.id}.optics")
        s.targets = [t for t in s.targets if grounded(t.quote, sources)]
    sheet.existing_assets = [a for a in sheet.existing_assets if grounded(a.quote, sources)]
    sheet.premises = [p for p in sheet.premises if grounded(p.quote, sources)]
    sheet.interpretations = [i for i in sheet.interpretations if grounded(i.term, sources)]
    questions = [q for q in sheet.client_question if grounded(q, sources)]
    sheet.client_question = questions or [q for s in sources for q in questions_from_text(s)][:3]
    return sheet, dropped


def build_extract_messages(enquiry: Enquiry, chat_facts) -> tuple[list[dict], str]:
    system, h1 = render("extract_system.j2")
    user, h2 = render("extract_user.j2", title=enquiry.title, text=enquiry.text, chat_facts=list(chat_facts),
                      matrix=MATRIX, optics=OPTICS, distance=DISTANCE, use_context=USE_CONTEXT,
                      certainty=CERTAINTY, asset_kinds=ASSET_KINDS, methods=METHODS,
                      premise_types=PREMISE_TYPES, domains=DOMAINS)
    return [{"role": "system", "content": system}, {"role": "user", "content": user}], f"{h1}{h2}"[:12]


def extract(enquiry: Enquiry, gateway, chat_facts=()) -> tuple[RequirementsSheet, dict]:
    messages, phash = build_extract_messages(enquiry, chat_facts)
    res = gateway.complete("extractor", messages, schema=RequirementsSheet, reasoning="off")
    sheet, dropped = ground_sheet(res.parsed, [enquiry.text, enquiry.title, *chat_facts])
    return sheet, {"model": res.model, "prompt_hash": phash, "dropped_ungrounded": dropped}
