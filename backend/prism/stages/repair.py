"""Stage 6: one targeted repair pass; anything still failing is removed or re-typed by code."""
from __future__ import annotations

import re

from prism.llm.prompts import render
from prism.schemas import EvidencePack, Issue, ReportBody, stricter
from prism.stages.draft import evidence_lines

_PLACEHOLDER = {"text": "Not supported by the available sources; to be confirmed with AFS.",
                "claim_type": "ASSUMPTION", "evidence_ids": []}
_STEP = re.compile(r"([a-z_]+)(?:\[(\d+)\])?")
_INDEXED = re.compile(r"\[\d+\]$")


def repair(body: ReportBody, issues: list[Issue], pack: EvidencePack, gateway, role: str = "generator") -> ReportBody:
    errors = [i for i in issues if i.severity == "error"]
    if not errors:
        return body
    system, _ = render("draft_system.j2")
    user, _ = render("repair.j2", issues=errors, evidence=evidence_lines(pack), body=body.model_dump_json(indent=1))
    fixed: ReportBody = gateway.complete(role, [{"role": "system", "content": system},
                                                {"role": "user", "content": user}], schema=ReportBody).parsed
    fixed.decision_status = stricter(fixed.decision_status, body.decision_status)
    return fixed


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


def strip_failing(body: ReportBody, issues: list[Issue]) -> ReportBody:
    data = body.model_dump(mode="json")
    # Deepest / highest indices first so earlier removals never shift a later target.
    targets = sorted({i.path for i in issues if i.severity == "error" and _INDEXED.search(i.path)},
                     key=lambda p: [int(n) for n in re.findall(r"\[(\d+)\]", p)], reverse=True)
    for path in targets:
        items, idx = _locate(data, path)
        if items is not None and idx < len(items) and isinstance(items[idx], dict) and "claim_type" in items[idx]:
            items.pop(idx)
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
    return ReportBody.model_validate(data)
