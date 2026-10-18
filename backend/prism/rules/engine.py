"""Symbolic engine: rules → candidates → decision status → counterfactual question seeds."""
from __future__ import annotations

from fnmatch import fnmatch

from prism.kb.loader import KnowledgeBase
from prism.rules.base import RuleContext, run_all
from prism.rules.geometry import optics_fit, sample_fit
from prism.schemas import (
    Candidate,
    DecisionStatus,
    Finding,
    QuestionSeed,
    RequirementsSheet,
    RuleFindings,
    Severity,
    Stream,
    stricter,
)

EVIDENCE_SCORE = {"process_application": 2.0, "lab_study": 1.0, "in_vitro_poc": 1.0, "method_general": 0.5}
IMPACT_ORDER = ["STATUS_CHANGE", "PRIMARY_METHOD_CHANGE", "TECHNIQUE_CHANGE", "RISK_ONLY"]
CF_DOMAINS = {"matrix": ["liquid", "powder", "paste", "solid"], "optics": ["clear", "turbid", "opaque"],
              "distance": ["at_process", "remote"]}
PLAN_SLOTS = ("concentration_range", "accuracy_and_limits", "reference_method", "process_conditions",
              "response_time")
_SILICA = ("visnir_silica", "uvvis_silica")


def link_fit(method: str, distance: str, kb: KnowledgeBase) -> tuple[float, list[str]]:
    mrange = kb.method_range(method)
    if any(mrange.coverage_by(kb.fiber_range(f)) >= 0.5 for f in _SILICA if f in kb.fibers):
        return 1.0, []
    if distance == "at_process":
        return 1.0, []
    if distance == "unknown":
        return 0.75, ["Mid-IR fiber link length still to be confirmed."]
    return 0.5, ["A long mid-IR fiber link is not documented in the materials."]


def evidence_fit(method: str, technique_id: str, stream: Stream, sheet: RequirementsSheet,
                 kb: KnowledgeBase) -> tuple[float, list[str]]:
    best, ids = 0.0, []
    for app in kb.applications:
        if method not in app["methods"] or technique_id not in app.get("techniques", []):
            continue
        matrix_ok = stream.matrix.value in ("unknown", app.get("matrix"))
        if app["domain"] == sheet.domain and matrix_ok:
            score = EVIDENCE_SCORE.get(app["scope"], 0.5)
        elif matrix_ok:
            score = min(1.0, EVIDENCE_SCORE.get(app["scope"], 0.5))   # analogous application elsewhere
        else:
            continue
        if score > best:
            best, ids = score, list(app["cards"])
    if best == 0.0:
        best, ids = 0.5, list(kb.methods[method].get("general_cards", []))[:2]
    return best, ids


def generate_candidates(ctx: RuleContext, findings: list[Finding]) -> list[Candidate]:
    sheet, kb = ctx.sheet, ctx.kb
    blocks = [(pattern, f) for f in findings for pattern in f.blocks]
    out = []
    for stream in sheet.streams:
        for tid, tech in kb.techniques.items():
            if not tech["in_line"]:
                continue
            fit = sample_fit(tech, stream.matrix.value)
            if fit == 0.0:
                continue
            key = f"{stream.id}:{tech['method']}:{tid}"
            hits = [f for pattern, f in blocks if fnmatch(key, pattern)]
            ev, ev_ids = evidence_fit(tech["method"], tid, stream, sheet, kb)
            link, notes = link_fit(tech["method"], sheet.distance.value, kb)
            out.append(Candidate(
                key=key, method=tech["method"], technique=tech["technique"], technique_id=tid, stream_id=stream.id,
                fit=fit, optics=optics_fit(tech, stream.optics.value), evidence=ev, link=link, blocked=bool(hits),
                reasons=[*notes, *[f.message for f in hits]], evidence_ids=[tech["card"], *ev_ids]))
    out.sort(key=lambda c: (c.blocked, -c.score, c.key))
    return out


def decide_status(findings: list[Finding], candidates: list[Candidate]) -> DecisionStatus:
    status = DecisionStatus.PROVISIONAL
    for f in findings:
        if f.severity == Severity.gate and f.status:
            status = stricter(status, f.status)
    if not candidates:
        status = stricter(status, DecisionStatus.OUTSIDE_SUPPORTED_SCOPE)
    elif all(c.blocked for c in candidates):
        status = stricter(status, DecisionStatus.INSUFFICIENT_INFORMATION)
    return status


def _core(sheet: RequirementsSheet, kb: KnowledgeBase):
    ctx = RuleContext(sheet, kb)
    findings = run_all(ctx)
    candidates = generate_candidates(ctx, findings)
    return findings, candidates, decide_status(findings, candidates)


def _signature(sheet: RequirementsSheet, kb: KnowledgeBase):
    findings, candidates, status = _core(sheet, kb)
    rf = RuleFindings(findings=findings, candidates=candidates, status=status)
    tops = [c for s in sheet.streams for c in rf.top(s.id, 2)]
    return status, tuple(sorted({c.method for c in tops})), tuple(sorted({c.technique_id for c in tops}))


def _impact(signatures: dict) -> str | None:
    statuses = {s for s, _, _ in signatures.values()}
    method_sets = {m for _, m, _ in signatures.values()}
    technique_sets = {t for _, _, t in signatures.values()}
    if len(statuses) > 1:
        return "STATUS_CHANGE"
    if len(method_sets) > 1:
        return "PRIMARY_METHOD_CHANGE"
    if len(technique_sets) > 1:
        return "TECHNIQUE_CHANGE"
    return None


def _counterfactual_slots(sheet: RequirementsSheet) -> list[tuple[str, list[str]]]:
    slots = []
    for s in sheet.streams:
        if s.matrix.value == "unknown":
            slots.append((f"streams.{s.id}.matrix", CF_DOMAINS["matrix"]))
        if s.optics.value == "unknown" and s.matrix.value in ("liquid", "unknown"):
            slots.append((f"streams.{s.id}.optics", CF_DOMAINS["optics"]))
    if sheet.distance.value == "unknown":
        slots.append(("distance", CF_DOMAINS["distance"]))
    return slots


def question_seeds(sheet: RequirementsSheet, kb: KnowledgeBase, findings: list[Finding]) -> list[QuestionSeed]:
    seeds: list[QuestionSeed] = []
    for slot, values in _counterfactual_slots(sheet):
        sigs = {v: _signature(sheet.with_value(slot, v), kb) for v in values}
        impact = _impact(sigs)
        if impact:
            seeds.append(QuestionSeed(slot=slot, impact=impact, outcomes={
                v: f"{s.value}; methods: {', '.join(m) or 'none'}; techniques: {', '.join(t) or 'none'}"
                for v, (s, m, t) in sigs.items()}))
    for f in findings:
        if f.question:
            seeds.append(QuestionSeed(slot=f.rule_id, impact=f.question_impact or "RISK_ONLY",
                                      rule_ids=[f.rule_id], text_hint=f.question))
    for it in sheet.interpretations:
        if it.ambiguous and it.alternatives:
            seeds.append(QuestionSeed(slot=f"term:{it.term}", impact="PRIMARY_METHOD_CHANGE",
                                      text_hint=f"When you write '{it.term}', do you mean "
                                                f"{' or '.join(it.alternatives)}?"))
    for slot in PLAN_SLOTS:
        if not getattr(sheet, slot).stated:
            seeds.append(QuestionSeed(slot=slot, impact="RISK_ONLY"))
    unique: dict[str, QuestionSeed] = {}
    for q in sorted(seeds, key=lambda q: IMPACT_ORDER.index(q.impact)):
        unique.setdefault(q.slot, q)
    return list(unique.values())[:10]


_DECISIVE = ("STATUS_CHANGE", "PRIMARY_METHOD_CHANGE")


def _decisive_unknown(sheet: RequirementsSheet, kb: KnowledgeBase, findings: list[Finding]) -> bool:
    """Whether `question_seeds` would hold a seed that can change the status or the primary method. It stops at the
    first one it finds, which is what makes a hypothetical evaluation cheap."""
    if any(f.question and f.question_impact in _DECISIVE for f in findings):
        return True
    if any(it.ambiguous and it.alternatives for it in sheet.interpretations):
        return True
    return any(_impact({v: _signature(sheet.with_value(slot, v), kb) for v in values}) in _DECISIVE
               for slot, values in _counterfactual_slots(sheet))


def evaluate(sheet: RequirementsSheet, kb: KnowledgeBase) -> RuleFindings:
    findings, candidates, status = _core(sheet, kb)
    seeds = question_seeds(sheet, kb, findings)
    decisive = any(q.impact in _DECISIVE for q in seeds)
    if sheet.requested_certainty.value in ("approve", "exact_config") and decisive:
        status = stricter(status, DecisionStatus.INSUFFICIENT_INFORMATION)
    return RuleFindings(findings=findings, candidates=candidates, question_seeds=seeds, status=status)


def evaluate_quick(sheet: RequirementsSheet, kb: KnowledgeBase) -> RuleFindings:
    """`evaluate` without the question seeds (empty here): the same findings, candidates and status, several times
    faster. The clarify gate runs it once per hypothetical answer."""
    findings, candidates, status = _core(sheet, kb)
    if sheet.requested_certainty.value in ("approve", "exact_config") and _decisive_unknown(sheet, kb, findings):
        status = stricter(status, DecisionStatus.INSUFFICIENT_INFORMATION)
    return RuleFindings(findings=findings, candidates=candidates, status=status)
