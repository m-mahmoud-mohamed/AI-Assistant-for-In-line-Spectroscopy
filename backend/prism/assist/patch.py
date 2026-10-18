"""Sentence-level patching: fix only the sentences that failed verification, never the whole report.

Per failing sentence the patcher (role `patcher`, one call per round for all of them) picks one action, in this order of
preference: relabel (honest label instead of a claim), hedge (weaken to what the quotes allow), rewrite-to-quote (restate
what the quotes say, edit-size capped) or delete. Code applies each action only if it passes its own guard, re-verifies
deterministically and tries at most `MAX_ROUNDS` times. Whatever still fails is removed (`strip_failing`).
"""
from __future__ import annotations

import logging
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal

from pydantic import BaseModel, Field

from prism.llm.gateway import LLMUnavailable
from prism.llm.prompts import render
from prism.schemas import Card, ClaimType, Issue, ReportBody, iter_segments
from prism.stages.checks import numbers
from prism.stages.repair import _locate, drop_segments, strip_failing
from prism.stages.verify import QUOTE_COVERAGE, cited_text, coverage

log = logging.getLogger(__name__)

MAX_ROUNDS = 2
EDIT_FLOOR, EDIT_RATIO = 160, 1.3         # a patched sentence may be this much longer than the original
SEGMENT_MAX = 600
RELABEL_TO = (ClaimType.ASSUMPTION, ClaimType.PROPOSAL, ClaimType.UNKNOWN)
_SUPPORT_CHECKS = ("C-SUPPORT", "C-IDS", "C-WEB-VERIFIED")
_INDEX = re.compile(r"^(.*)\[(\d+)\]$")


class PatchItem(BaseModel):
    id: str
    action: Literal["relabel", "hedge", "rewrite", "delete"]
    claim_type: ClaimType | None = None
    text: str | None = None


class PatchResponse(BaseModel):
    patches: list[PatchItem] = Field(default_factory=list)


@dataclass
class PatchOutcome:
    body: ReportBody
    issues: list[Issue]
    rounds: int = 0
    calls: int = 0
    model: str = ""
    actions: list[dict] = field(default_factory=list)       # {path, action, round} for every applied fix
    stripped: list[str] = field(default_factory=list)       # paths removed at the end


Recheck = Callable[[ReportBody, set[str]], list[Issue]]


def failing_sentences(body: ReportBody, issues: list[Issue]) -> dict[str, list[Issue]]:
    """Sentence path -> its issues, for the errors and the partial-support warnings that name a sentence."""
    segment_paths = {path for path, _ in iter_segments(body)}
    out: dict[str, list[Issue]] = {}
    for i in issues:
        if i.path in segment_paths and (i.severity == "error" or i.message.startswith("partial")):
            out.setdefault(i.path, []).append(i)
    return out


def _segment(data: dict, path: str) -> dict | None:
    items, idx = _locate(data, path)
    return items[idx] if items is not None and idx < len(items) else None


def _allowed_numbers(old: str, quotes: str) -> set[str]:
    return numbers(old) | numbers(quotes)


def apply_item(seg: dict, item: PatchItem, quotes: str) -> str | None:
    """Apply one action to a segment dict in place. Returns the action applied, 'delete' to remove the sentence, or
    None when the proposal failed its guard (the sentence keeps failing and the next round escalates)."""
    old = seg["text"]
    cap = max(EDIT_FLOOR, int(len(old) * EDIT_RATIO))
    text = (item.text or "").strip()
    if item.action == "delete":
        return "delete"
    if item.action == "relabel":
        if item.claim_type not in RELABEL_TO:
            return None
        seg["claim_type"] = item.claim_type.value
        if item.claim_type in (ClaimType.ASSUMPTION, ClaimType.UNKNOWN):
            seg["evidence_ids"] = []
        return "relabel"
    if not text or len(text) > min(cap, SEGMENT_MAX) or text == old:
        return None
    if numbers(text) - _allowed_numbers(old, quotes):
        return None                                             # a fix may not bring in a new number
    if item.action == "rewrite" and coverage(text, quotes) < QUOTE_COVERAGE:
        return None                                             # a rewrite must stay within its quotes
    seg["text"] = text
    return item.action


def _default_item(sid: str, claim_type: str, problems: list[Issue], round_: int) -> PatchItem | None:
    """When the patcher omits a sentence: an unsupported claim becomes an honest assumption (round 1)."""
    if round_ == 1 and claim_type in ("AFS", "EXTERNAL", "CLIENT") and any(
            i.check_id in _SUPPORT_CHECKS for i in problems):
        return PatchItem(id=sid, action="relabel", claim_type=ClaimType.ASSUMPTION)
    return None


def patch_body(body: ReportBody, issues: list[Issue], cards: dict[str, Card], gateway, recheck: Recheck,
               role: str = "patcher", max_rounds: int = MAX_ROUNDS,
               on_round: Callable[[int, dict[str, list[Issue]]], None] | None = None) -> PatchOutcome:
    """Patch failing sentences for at most `max_rounds` rounds (one patcher call each), then strip what is left.
    `recheck(body, changed_paths)` is the deterministic re-verification (it also carries judge verdicts over)."""
    out = PatchOutcome(body=body, issues=issues)
    for round_ in range(1, max_rounds + 1):
        targets = failing_sentences(out.body, out.issues)
        if not targets:
            break
        out.rounds = round_
        if on_round is not None:
            on_round(round_, targets)
        by_id = {f"s{n}": path for n, path in enumerate(targets, start=1)}
        segs = dict(iter_segments(out.body))
        proposals: dict[str, PatchItem] = {}
        if gateway is not None:
            sentences = [{"id": sid, "claim_type": segs[path].claim_type.value, "text": segs[path].text,
                          "problems": [i.message for i in targets[path]],
                          "quotes": [f"[{c}] {cards[c].quote}" for c in segs[path].evidence_ids if c in cards]}
                         for sid, path in by_id.items()]
            prompt, _ = render("patch.j2", sentences=sentences, round=round_)
            out.calls += 1
            try:
                res = gateway.complete(role, [{"role": "user", "content": prompt}], schema=PatchResponse)
            except LLMUnavailable as exc:
                log.warning("patcher unavailable, falling back to code-only fixes: %s", exc)
            else:
                out.model = res.model
                proposals = {p.id: p for p in res.parsed.patches if p.id in by_id}
        data = out.body.model_dump(mode="json")
        deletes, changed = [], set()
        for sid, path in by_id.items():
            seg = _segment(data, path)
            if seg is None:
                continue
            item = proposals.get(sid) or _default_item(sid, seg["claim_type"], targets[path], round_)
            if item is None:
                continue
            quotes = cited_text(cards, segs[path])
            applied = apply_item(seg, item, quotes)
            if applied == "delete":
                deletes.append(path)
            elif applied:
                changed.add(path)
            if applied:
                out.actions.append({"path": path, "action": applied, "round": round_})
        out.body = ReportBody.model_validate(data)
        if deletes:
            out.body = drop_segments(out.body, deletes)
            changed = remap(changed, deletes)
        out.issues = recheck(out.body, changed)
    remaining = [i for i in out.issues if i.severity == "error"]
    if remaining:
        out.stripped = sorted({i.path for i in remaining if re.search(r"\[\d+\]$", i.path)})
        out.body = strip_failing(out.body, remaining)
        out.issues = recheck(out.body, set())
    return out


def remap(paths: set[str], deleted: list[str]) -> set[str]:
    """Sentence paths after some sentences were deleted from their lists (later indices move up)."""
    gone = set(deleted)
    out = set()
    for path in paths:
        m = _INDEX.match(path)
        if path in gone or m is None:
            continue
        parent, idx = m.group(1), int(m.group(2))
        shift = sum(1 for d in gone if (dm := _INDEX.match(d)) and dm.group(1) == parent and int(dm.group(2)) < idx)
        out.add(f"{parent}[{idx - shift}]")
    return out
