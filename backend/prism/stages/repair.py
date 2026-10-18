"""Stage 6 (last resort): remove the sentences that still fail after patching, keeping the report valid.

Whole-report repair no longer exists: failing sentences are patched one by one (prism/assist/patch.py) and anything
that is still failing after the last round is removed here, or re-typed by code.
"""
from __future__ import annotations

import re

from prism.schemas import Issue, ReportBody

_PLACEHOLDER = {"text": "Not supported by the available sources; to be confirmed with AFS.",
                "claim_type": "ASSUMPTION", "evidence_ids": []}
_STEP = re.compile(r"([a-z_]+)(?:\[(\d+)\])?")
_INDEXED = re.compile(r"\[\d+\]$")


def _locate(data: dict, path: str):
    """Return (list, index) for a path ending in [i], e.g. 'recommendations[0].rationale[2]'."""
    node, parts = data, path.split(".")
    try:
        for part in parts[:-1]:
            name, idx = _STEP.fullmatch(part).groups()
            node = node[name] if idx is None else node[name][int(idx)]
        name, idx = _STEP.fullmatch(parts[-1]).groups()
        return (node[name], int(idx)) if idx is not None else (None, None)
    except (AttributeError, KeyError, IndexError, TypeError):
        return None, None


def _fill_required(data: dict) -> None:
    """Whatever must not be empty gets an honest placeholder."""
    for r in data["recommendations"]:
        if not r["rationale"]:
            r["rationale"], r["role"] = [dict(_PLACEHOLDER)], "CONDITIONAL"
    if not data["decision_basis"]:
        data["decision_basis"] = [dict(_PLACEHOLDER)]
    if not data["direct_answer"]["text"]:
        data["direct_answer"]["text"] = [dict(_PLACEHOLDER)]
    for pc in data["premise_checks"]:
        if not pc["explanation"]:
            pc["explanation"] = [dict(_PLACEHOLDER)]
    data["risks"] = [r for r in data["risks"] if r["risk"]]


def drop_segments(body: ReportBody, paths) -> ReportBody:
    """Remove the sentences at the given paths (highest indices first, so earlier removals never shift a target)."""
    data = body.model_dump(mode="json")
    targets = sorted({p for p in paths if _INDEXED.search(p)},
                     key=lambda p: [int(n) for n in re.findall(r"\[(\d+)\]", p)], reverse=True)
    for path in targets:
        items, idx = _locate(data, path)
        if items is not None and idx < len(items) and isinstance(items[idx], dict) and "claim_type" in items[idx]:
            items.pop(idx)
    _fill_required(data)
    return ReportBody.model_validate(data)


def strip_failing(body: ReportBody, issues: list[Issue]) -> ReportBody:
    return drop_segments(body, {i.path for i in issues if i.severity == "error"})
