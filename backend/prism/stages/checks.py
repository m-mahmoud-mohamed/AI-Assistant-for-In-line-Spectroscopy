"""Deterministic verification: consistency checks (C-*) and output-policy checks (P-*)."""
from __future__ import annotations

import re
from dataclasses import dataclass

from rapidfuzz import fuzz

from prism.kb.loader import KnowledgeBase
from prism.schemas import (
    PREMISE_STRICTNESS,
    Card,
    ClaimType,
    EvidencePack,
    Issue,
    RecRole,
    ReportBody,
    RequirementsSheet,
    RuleFindings,
    VerificationReport,
    WebStatus,
    is_looser,
    iter_segments,
)
from prism.stages.extract import grounded

POLICY_IDS = ["C-IDS", "C-FINDINGS", "C-STATUS", "C-SUPPORT", "P-MIN-RECOMMENDATION", "P-DIRECT-ANSWER",
              "P-AFS-CITATION", "P-NO-NUMBERS", "P-NO-GUARANTEE", "P-NO-BAND-PICK", "P-NO-SELF-ANSWER",
              "P-PLAN-COMPLETE", "P-QUESTIONS", "P-LENGTH", "P-SCOPE", "C-WEB-VERIFIED"]
AFS_SOURCES = {"S01", "S02", "S03", "S04", "S05", "TABLE"}
# A digit right after "letter-" is a unit exponent (cm-1, m-2), not a value.
_NUM = re.compile(r"(?<![\w.])(?<![A-Za-z]-)\d+(?:[.,]\d+)?")
_CODE = re.compile(r"\b[A-Za-z]{1,6}-?\d{2,5}[A-Za-z]?\b")
_GUARANTEE = re.compile(r"\b(guarantee[sd]?|ensures?|proven|validated for|ready for|will (?:work|succeed|ensure)|"
                        r"certainly|definitely)\b", re.IGNORECASE)
_BAND_PICK = re.compile(r"\b(optimal|best|ideal)\s+(?:\w+\s+){0,2}(band|wavelength|range|region|window)s?\b", re.IGNORECASE)
SEGMENT_MAX, TOTAL_MAX = 600, 15000


def numbers(text: str) -> set[str]:
    out = set()
    for n in _NUM.findall(text):
        if re.fullmatch(r"\d{1,3}(,\d{3})+", n):
            out.add(n.replace(",", ""))
        else:
            out.add(n.replace(",", "."))
    return out


@dataclass
class CheckContext:
    body: ReportBody
    sheet: RequirementsSheet
    findings: RuleFindings
    pack: EvidencePack
    kb: KnowledgeBase
    source_texts: list[str]

    def card(self, cid: str) -> Card | None:
        """A pack card (including this run's verified web cards) or a KB card."""
        for c in (self.pack.cards if self.pack else ()):
            if c.id == cid:
                return c
        return self.kb.cards.get(cid)


def _cited_text(cx: CheckContext, ids) -> str:
    cards = [c for c in (cx.card(i) for i in ids) if c is not None]
    return " ".join(f"{c.quote} {c.claim}" for c in cards)


def check_ids(cx: CheckContext) -> list[Issue]:
    out, pack_ids = [], cx.pack.ids()
    for path, s in iter_segments(cx.body):
        for cid in s.evidence_ids:
            if cid not in pack_ids:
                out.append(Issue(check_id="C-IDS", path=path, message=f"cites {cid}, which is not in the evidence pack"))
        cards = [c for c in (cx.card(i) for i in s.evidence_ids) if c is not None]
        if s.claim_type == ClaimType.AFS and not any(c.source in AFS_SOURCES for c in cards):
            out.append(Issue(check_id="C-IDS", path=path, message="AFS claim without an AFS evidence card"))
        if s.claim_type == ClaimType.EXTERNAL and not any(c.source == "EXT" for c in cards):
            out.append(Issue(check_id="C-IDS", path=path, message="external claim without an external card"))
    return out


def check_numbers(cx: CheckContext) -> list[Issue]:
    allowed = {str(i) for i in range(1, 10)}
    source = " ".join(cx.source_texts)
    for t in cx.source_texts:
        allowed |= numbers(t)
    out = []
    items = [(p, s.text, s.evidence_ids) for p, s in iter_segments(cx.body)]
    for i, r in enumerate(cx.body.spectral_ranges):
        ids = [c for seg_ in r.caveat for c in seg_.evidence_ids]
        ids += cx.kb.methods.get(r.method, {}).get("range_cards", [])
        items.append((f"spectral_ranges[{i}]", f"{r.nominal_range} {r.excitation_nm or ''}", ids))
    for path, text, ids in items:
        cited = _cited_text(cx, ids)
        bad = sorted(numbers(text) - allowed - numbers(cited))
        codes = [c for c in _CODE.findall(text) if c.lower() not in (source + cited).lower()]
        if bad or codes:
            out.append(Issue(check_id="P-NO-NUMBERS", path=path,
                             message=f"not found in the enquiry or cited cards: {', '.join(bad + codes)}"))
    return out


def check_wording(cx: CheckContext) -> list[Issue]:
    out = []
    for path, s in iter_segments(cx.body):
        cited = _cited_text(cx, s.evidence_ids).lower()
        g = _GUARANTEE.search(s.text)
        if g and g.group(0).lower() not in cited:
            out.append(Issue(check_id="P-NO-GUARANTEE", path=path, message=f"over-claiming wording: '{g.group(0)}'"))
        if _BAND_PICK.search(s.text):
            out.append(Issue(check_id="P-NO-BAND-PICK", path=path, message="picks an optimal band without spectra"))
        if len(s.text) > SEGMENT_MAX:
            out.append(Issue(check_id="P-LENGTH", path=path, message=f"segment longer than {SEGMENT_MAX} characters"))
    for i, r in enumerate(cx.body.spectral_ranges):
        if _BAND_PICK.search(r.nominal_range):
            out.append(Issue(check_id="P-NO-BAND-PICK", path=f"spectral_ranges[{i}]", message="optimal band picked"))
    if len(cx.body.model_dump_json()) > TOTAL_MAX * 3:
        out.append(Issue(check_id="P-LENGTH", path="", message="report is too long"))
    return out


def check_self_answer(cx: CheckContext) -> list[Issue]:
    return [Issue(check_id="P-NO-SELF-ANSWER", path=f"requirements.stated_facts[{i}]",
                  message="stated fact is not a quote of the client")
            for i, f in enumerate(cx.body.requirements.stated_facts) if not grounded(f.quote, cx.source_texts)]


def check_structure(cx: CheckContext) -> list[Issue]:
    b, out = cx.body, []
    if not any(r.role != RecRole.NOT_RECOMMENDED for r in b.recommendations):
        out.append(Issue(check_id="P-MIN-RECOMMENDATION", path="recommendations",
                         message="no recommendation that is worth testing (use SCREENING or CONDITIONAL)"))
    if not "".join(s.text for s in b.direct_answer.text).strip():
        out.append(Issue(check_id="P-DIRECT-ANSWER", path="direct_answer", message="empty direct answer"))
    qs = b.clarification_questions
    if not 3 <= len(qs) <= 6:
        out.append(Issue(check_id="P-QUESTIONS", path="clarification_questions", message=f"{len(qs)} questions; need 3–6"))
    if any(not q.decision_it_changes.strip() for q in qs) or [q.priority for q in qs] != sorted({q.priority for q in qs}):
        out.append(Issue(check_id="P-QUESTIONS", path="clarification_questions",
                         message="priorities must be unique and ordered, each with decision_it_changes"))
    p = b.feasibility_plan
    empty = [n for n in ("samples_and_states", "reference_measurements", "setup", "comparison", "validation",
                         "go_no_go", "not_demonstrated") if not getattr(p, n)]
    if empty or not 1 <= len(p.steps) <= 6:
        out.append(Issue(check_id="P-PLAN-COMPLETE", path="feasibility_plan",
                         message=f"missing {', '.join(empty) or '-'}; steps={len(p.steps)} (max 6)"))
    return out


def _has_afs(cx: CheckContext, ids) -> bool:
    return any(c.source in AFS_SOURCES for c in (cx.card(i) for i in ids) if c is not None)


def check_afs_citation(cx: CheckContext) -> list[Issue]:
    out, b = [], cx.body
    rec_ids_by_stream: dict[str, list[str]] = {}
    for i, r in enumerate(b.recommendations):
        ids = [c for s in (*r.rationale, *r.conditions, *r.limitations) for c in s.evidence_ids]
        for sid in r.applies_to:
            rec_ids_by_stream.setdefault(sid, []).extend(ids)
        if r.role != RecRole.NOT_RECOMMENDED and not _has_afs(cx, ids):
            out.append(Issue(check_id="P-AFS-CITATION", path=f"recommendations[{i}]", message="no AFS source cited"))
    for i, sr in enumerate(b.spectral_ranges):
        if not _has_afs(cx, [c for s in sr.caveat for c in s.evidence_ids]):
            out.append(Issue(check_id="P-AFS-CITATION", path=f"spectral_ranges[{i}]", message="no AFS source cited"))
    for i, mc in enumerate(b.measurement_concept):
        ids = [c for s in mc.notes for c in s.evidence_ids] + rec_ids_by_stream.get(mc.stream_id, [])
        if not _has_afs(cx, ids):
            out.append(Issue(check_id="P-AFS-CITATION", path=f"measurement_concept[{i}]", message="no AFS source cited"))
    return out


def external_card_ok(card: Card) -> bool:
    """An external card may be cited if code verified it (every check true, same URL) or if it is a curated
    KB card that a human reviewed (status seed / accepted, no web verification involved)."""
    v = card.verification
    if v is not None:
        return v.status == WebStatus.VERIFIED and bool(v.checks) and all(v.checks.values()) and v.url == card.url
    return card.status in ("seed", "accepted") and bool(card.url and card.retrieved_at)


def check_web(cx: CheckContext) -> list[Issue]:
    """C-WEB-VERIFIED: every cited external card carries a VERIFIED verification and is cited as EXTERNAL."""
    out = []
    for path, s in iter_segments(cx.body):
        for cid in s.evidence_ids:
            card = cx.card(cid)
            if card is None or card.source != "EXT":
                continue
            if not external_card_ok(card):
                out.append(Issue(check_id="C-WEB-VERIFIED", path=path,
                                 message=f"cites external card {cid} without a VERIFIED source verification"))
            elif s.claim_type != ClaimType.EXTERNAL:
                out.append(Issue(check_id="C-WEB-VERIFIED", path=path,
                                 message=f"external card {cid} is cited as {s.claim_type.value}; use EXTERNAL"))
    return out


def _technique_id(cx: CheckContext, method: str, name: str) -> str | None:
    name = name.lower()
    for tid, t in cx.kb.techniques.items():
        if t["method"] == method and (t["technique"].lower() in name or name in t["technique"].lower()):
            return tid
    return None


def check_findings(cx: CheckContext) -> list[Issue]:
    out, b = [], cx.body
    blocked = {(c.stream_id, c.method, c.technique_id) for c in cx.findings.candidates if c.blocked}
    for i, r in enumerate(b.recommendations):
        if r.role not in (RecRole.PRIMARY, RecRole.COMPARISON):
            continue
        for m in r.methods:
            tid = _technique_id(cx, m, r.technique)
            if any((sid, m, tid) in blocked for sid in r.applies_to):
                out.append(Issue(check_id="C-FINDINGS", path=f"recommendations[{i}]",
                                 message=f"recommends {m} {r.technique}, which the rules blocked"))
    for f in cx.findings.findings:
        if f.rule_id == "R-FIBER-WINDOW" and f.severity.value == "blocking":
            aliases = cx.kb.lexicon.get("fibers", {}).get(f.data.get("fiber_family", ""), [])
            uses = any(f.data.get("method") in r.methods and r.role in (RecRole.PRIMARY, RecRole.COMPARISON)
                       for r in b.recommendations)
            for j, mc in enumerate(b.measurement_concept):
                if uses and any(a in mc.fiber_link.lower() for a in aliases):
                    out.append(Issue(check_id="C-FINDINGS", path=f"measurement_concept[{j}]",
                                     message="concept reuses a fiber that cannot carry the method's range"))
        if f.premise_index is not None and f.premise_verdict is not None:
            text = cx.sheet.premises[f.premise_index].text if f.premise_index < len(cx.sheet.premises) else ""
            need = PREMISE_STRICTNESS[f.premise_verdict]
            ok = any(PREMISE_STRICTNESS[pc.verdict] >= need and fuzz.partial_ratio(pc.premise.lower(), text.lower()) >= 50
                     for pc in b.premise_checks)
            if not ok:
                out.append(Issue(check_id="C-FINDINGS", path="premise_checks",
                                 message=f"missing premise check '{text}' with verdict ≥ {f.premise_verdict.value}"))
    if is_looser(b.decision_status, cx.findings.status):
        out.append(Issue(check_id="C-STATUS", path="decision_status",
                         message=f"{b.decision_status.value} is looser than the rule floor {cx.findings.status.value}"))
    return out


_CHECKS = (check_ids, check_numbers, check_wording, check_self_answer, check_structure, check_afs_citation,
           check_findings, check_web)


def run_checks(cx: CheckContext) -> list[Issue]:
    return [issue for check in _CHECKS for issue in check(cx)]


def compliance(report: VerificationReport) -> dict[str, bool]:
    return {cid: not any(i.check_id == cid and i.severity == "error" for i in report.issues) for cid in POLICY_IDS}
