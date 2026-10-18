"""Stage 1b: map typos, synonyms, abbreviations and German terms to canonical ids; flag ambiguity."""
from __future__ import annotations

import re

from rapidfuzz import fuzz, process

from prism.kb.loader import KnowledgeBase
from prism.rules.physics import fiber_family_of
from prism.schemas import Fact, Interpretation, RequirementsSheet

_FUZZY_KINDS = {"methods": "method", "techniques": "technique", "fibers": "fiber"}
_MID_CONTEXT = re.compile(r"\batr\b|cm-1|cm\^-1|cm⁻¹|wavenumber|ftir|ft-ir|mid[- ]?ir|fingerprint", re.IGNORECASE)
_NEAR_CONTEXT = re.compile(r"\bnear\b|\bnir\b|\bnm\b|overtone", re.IGNORECASE)


def _pattern(term: str) -> re.Pattern:
    return re.compile(rf"(?<![\w-]){re.escape(term)}(?![\w-])", re.IGNORECASE)


def canonical_method(term: str | None, lexicon: dict) -> str | None:
    if not term:
        return None
    t = term.strip().lower()
    for canon, names in lexicon.get("methods", {}).items():
        if t == canon.lower() or t in names:
            return canon
    return None


def scan_terms(text: str, lexicon: dict) -> list[Interpretation]:
    found: list[Interpretation] = []
    masked = text
    for group, kind in _FUZZY_KINDS.items():
        for canon, names in lexicon.get(group, {}).items():
            # Longest alias first; every occurrence is recorded and masked so shorter aliases
            # (e.g. "nir" inside "ft-nir") cannot match the same span twice.
            for name in sorted(names, key=len, reverse=True):
                for m in list(_pattern(name).finditer(masked)):
                    found.append(Interpretation(term=text[m.start():m.end()], canonical=canon, kind=kind, how="exact"))
                    masked = masked[:m.start()] + " " * (m.end() - m.start()) + masked[m.end():]
    for term, alts in lexicon.get("ambiguous", {}).items():
        m = _pattern(term).search(masked)
        if m:
            found.append(Interpretation(term=text[m.start():m.end()], kind="method", how="exact",
                                        alternatives=list(alts), ambiguous=True))
    pool = {name: (canon, kind) for group, kind in _FUZZY_KINDS.items()
            for canon, names in lexicon.get(group, {}).items() for name in names if len(name) >= 5 and " " not in name}
    for m in re.finditer(r"[^\W\d_][\w-]{4,}", masked):
        token = m.group(0).lower()
        if token in pool:
            continue
        best = process.extractOne(token, list(pool), scorer=fuzz.ratio)
        if best and best[1] >= 88:
            canon, kind = pool[best[0]]
            found.append(Interpretation(term=m.group(0), canonical=canon, kind=kind, how="fuzzy"))
    return found


def disambiguate(items: list[Interpretation], text: str) -> list[Interpretation]:
    for it in items:
        if it.ambiguous and set(it.alternatives) == {"NIR", "MIR"}:
            if _MID_CONTEXT.search(text):
                it.canonical, it.ambiguous, it.how = "MIR", False, "context"
            elif _NEAR_CONTEXT.search(text):
                it.canonical, it.ambiguous, it.how = "NIR", False, "context"
    return items


# A general goal named as a target ("composition changes", "quality") is not a measurand of its own when the stream
# already has defined targets; alone it stays (the target is then honestly undefined).
_VAGUE_TARGET = re.compile(r"(?i)^(?:the\s+)?(?:general\s+|overall\s+|product\s+)?(?:composition|quality|process|"
                           r"properties|changes?)(?:\s+(?:changes?|variations?|deviations?|drift|monitoring))?$")
# "clinical" use must be supported by its own quote; a laboratory study on tissue is not clinical use.
_CLINICAL_WORDS = re.compile(r"(?i)\b(?:clinic\w*|patients?|surg\w*|diagnos\w*|in[- ]vivo|hospital\w*|therap\w*|"
                             r"medical decisions?|bedside|operating (?:room|theatre))\b")


def ground_values(sheet: RequirementsSheet) -> RequirementsSheet:
    """Values the extraction filled in that their own quotes do not carry: vague goals next to defined targets, and a
    clinical use context without clinical words in its quote."""
    for s in sheet.streams:
        defined = [t for t in s.targets if t.defined and not _VAGUE_TARGET.match(t.name.strip())]
        if defined:
            s.targets = [t for t in s.targets if not _VAGUE_TARGET.match(t.name.strip())]
    uc = sheet.use_context
    if uc.value == "clinical" and not _CLINICAL_WORDS.search(uc.quote or ""):
        sheet.use_context = Fact()
    return sheet


def normalise_sheet(sheet: RequirementsSheet, text: str, kb: KnowledgeBase) -> RequirementsSheet:
    sheet = ground_values(sheet)
    lex = kb.lexicon
    canon_ids = {c for group in _FUZZY_KINDS for c in lex.get(group, {})}
    for p in sheet.premises:
        p.method = canonical_method(p.method, lex) or (p.method if p.method in kb.methods else None)
    for a in sheet.existing_assets:
        a.method = canonical_method(a.method, lex) or (a.method if a.method in kb.methods else None)
        if a.kind == "fiber":
            a.fiber_family = fiber_family_of(a, kb)
    merged: dict[str, Interpretation] = {}
    llm_items = [i for i in sheet.interpretations if i.canonical is None or i.canonical in canon_ids]
    for it in [*disambiguate(scan_terms(text, lex), text), *llm_items]:
        merged.setdefault(it.term.lower(), it)
    sheet.interpretations = list(merged.values())
    return sheet
