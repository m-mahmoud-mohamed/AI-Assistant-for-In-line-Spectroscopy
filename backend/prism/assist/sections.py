"""Report sections: what code fills (the skeleton), what the three writers fill (prose), and how they merge.

Code owns every factual field: decision status, recommendations (methods, technique, role, scope), requirements,
spectral ranges, the structure of the measurement concept, the question list and the feasibility-plan template.
A writer returns prose segments (text, claim type, card ids) and nothing else. `merge` puts the pieces together and
always yields a valid `ReportBody`; whatever a writer leaves out is filled from card claims or the plan template.
"""
from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from fnmatch import fnmatch

from pydantic import BaseModel, Field

from prism.assist.clarify import NO_CHANGE, decision_text
from prism.kb.loader import KnowledgeBase
from prism.rules.base import RuleContext
from prism.rules.engine import IMPACT_ORDER, evidence_fit, link_fit
from prism.rules.geometry import optics_fit
from prism.schemas import (
    PREMISE_STRICTNESS,
    Assumption,
    Candidate,
    Card,
    ClaimType,
    ClarifyQuestion,
    DecisionStatus,
    DirectAnswer,
    EvidencePack,
    FeasibilityPlan,
    Finding,
    MeasurementConcept,
    PremiseCheck,
    PremiseVerdict,
    Question,
    QuestionSeed,
    Recommendation,
    RecRole,
    ReportBody,
    Requirements,
    RequirementsSheet,
    Risk,
    RuleFindings,
    Segment,
    Severity,
    SpectralRange,
    Verdict,
    iter_segments,
)
from prism.stages.checks import AFS_SOURCES, NumberGuard
from prism.stages.render import fibers_for, key_unknowns, spectral_range_for, stated_facts

SECTIONS = ("answer", "concept", "plan")
# Report fields each section owns (used by `section_ready` events).
SECTION_PATHS = {
    "answer": ["direct_answer", "premise_checks", "recommendations"],
    "concept": ["measurement_concept", "spectral_ranges", "risks", "assumptions"],
    "plan": ["clarification_questions", "feasibility_plan", "decision_basis"],
}
MAX_QUESTIONS, MIN_QUESTIONS = 6, 3
MAX_PER_STREAM = 3                   # methods recommended per stream
COMPARISON_MARGIN = 1.5              # score gap to the best candidate that still counts as a comparison method
APPLICATION_FIT = 1.5                # sample fit of a technique that only a curated application supports
STRONG_EVIDENCE = 2.0                # a same-domain process application in the knowledge base
SCREEN_TECHNIQUE = "multi-method screening on retained samples"
COMBO_TECHNIQUE = "combined measurement (only after each method is assessed alone)"
FALLBACK_SCREEN = ("NIR", "Raman")   # when the engine has no in-line candidate at all


# ---------------------------------------------------------------- what the writers return

class RecProse(BaseModel):
    rec_id: str = Field(description="id of a recommendation in the skeleton, for example r1")
    rationale: list[Segment] = Field(default_factory=list)
    conditions: list[Segment] = Field(default_factory=list)
    limitations: list[Segment] = Field(default_factory=list)


class PremiseProse(BaseModel):
    premise_id: str = Field(description="id of a premise in the skeleton, for example p0")
    explanation: list[Segment] = Field(default_factory=list)


class AnswerSection(BaseModel):
    """Writer A: the recommendations' prose, the premise explanations and, last, the direct answer."""
    recommendations: list[RecProse] = Field(default_factory=list)
    premise_checks: list[PremiseProse] = Field(default_factory=list)
    direct_answer: list[Segment] = Field(default_factory=list)
    verdict: Verdict = Verdict.CONDITIONAL


class ConceptProse(BaseModel):
    stream_id: str
    notes: list[Segment] = Field(default_factory=list)


class RangeProse(BaseModel):
    method: str
    caveats: list[Segment] = Field(default_factory=list)


class RiskProse(BaseModel):
    risk: list[Segment] = Field(default_factory=list)
    effect: str = ""
    mitigation: str = ""


class AssumptionProse(BaseModel):
    assumption: str
    to_confirm_with: str = "the client"


class ConceptSection(BaseModel):
    """Writer B: measurement-concept explanations, spectral caveats, risks and assumptions."""
    concepts: list[ConceptProse] = Field(default_factory=list)
    spectral_caveats: list[RangeProse] = Field(default_factory=list)
    risks: list[RiskProse] = Field(default_factory=list)
    assumptions: list[AssumptionProse] = Field(default_factory=list)


class QuestionProse(BaseModel):
    question_id: str = Field(description="id of a question in the skeleton, for example q1")
    question: str


class PlanProse(BaseModel):
    objective: str = ""
    samples_and_states: list[Segment] = Field(default_factory=list)
    reference_measurements: list[Segment] = Field(default_factory=list)
    setup: list[Segment] = Field(default_factory=list)
    comparison: list[Segment] = Field(default_factory=list)
    validation: list[Segment] = Field(default_factory=list)
    go_no_go: list[Segment] = Field(default_factory=list)
    not_demonstrated: list[Segment] = Field(default_factory=list)
    steps: list[str] = Field(default_factory=list, description="at most 6 short steps")


class PlanSection(BaseModel):
    """Writer C: question wording, the feasibility plan's wording and the decision basis."""
    questions: list[QuestionProse] = Field(default_factory=list)
    plan: PlanProse = Field(default_factory=PlanProse)
    decision_basis: list[Segment] = Field(default_factory=list)


SECTION_SCHEMAS = {"answer": AnswerSection, "concept": ConceptSection, "plan": PlanSection}
PLAN_ELEMENTS = ("samples_and_states", "reference_measurements", "setup", "comparison", "validation", "go_no_go",
                 "not_demonstrated")


# ---------------------------------------------------------------- the skeleton (all filled by code)

class RecSkel(BaseModel):
    id: str
    methods: list[str]
    technique: str
    applies_to: list[str]
    role: RecRole
    reasons: list[str] = Field(default_factory=list)          # why code chose this role (rule messages)
    evidence_ids: list[str] = Field(default_factory=list)     # cards that bear on it (candidates, method cards)
    fallback: list[Segment] = Field(default_factory=list)     # code-written rationale, supported by card claims


class PremiseSkel(BaseModel):
    id: str
    index: int
    premise: str
    verdict: PremiseVerdict
    findings: list[str] = Field(default_factory=list)         # rule messages that bind this premise
    evidence_ids: list[str] = Field(default_factory=list)


class QuestionSkel(BaseModel):
    id: str
    slot: str
    stream_id: str | None = None
    priority: int
    impact: str
    decision_it_changes: str
    question: str                    # expert template or rule wording; the writer may rephrase it
    why: str


class ConceptSkel(BaseModel):
    stream_id: str
    probe_geometry: str
    location: str
    fiber_link: str


class PlanSkel(BaseModel):
    objective: str
    clarify_first: list[str]
    steps: list[str]
    defaults: dict[str, str]         # element -> template sentence (a PROPOSAL, no numbers)
    decision_basis: str


class Skeleton(BaseModel):
    status: DecisionStatus
    recs: list[RecSkel]
    premises: list[PremiseSkel] = Field(default_factory=list)
    questions: list[QuestionSkel] = Field(default_factory=list)
    concepts: list[ConceptSkel] = Field(default_factory=list)
    ranges: list[SpectralRange] = Field(default_factory=list)
    requirements: Requirements = Field(default_factory=Requirements)
    plan: PlanSkel

    def recommended_methods(self) -> list[str]:
        """Methods that get a spectral range, in order of first appearance."""
        return list(dict.fromkeys(m for r in self.recs if r.role != RecRole.NOT_RECOMMENDED for m in r.methods))


def method_cards(kb: KnowledgeBase, method: str) -> list[str]:
    m = kb.methods.get(method, {})
    return [*m.get("range_cards", []), *m.get("limitation_cards", []), *m.get("general_cards", [])]


def _afs_cards(kb: KnowledgeBase, ids: list[str]) -> list[Card]:
    return [c for c in kb.cards_for(ids) if c.source in AFS_SOURCES]


def card_segment(card: Card) -> Segment:
    """A sentence that is supported by construction: the card's own claim, cited."""
    return Segment(text=card.claim.strip(), claim_type=ClaimType.EXTERNAL if card.source == "EXT" else ClaimType.AFS,
                   evidence_ids=[card.id])


# ---- candidates backed by curated application evidence

def evidence_led_candidates(sheet: RequirementsSheet, findings: RuleFindings, kb: KnowledgeBase) -> list[Candidate]:
    """In-line techniques that a curated process application of the same domain and sample type supports but the
    sample-type table does not list for this matrix (for example NIR diffuse reflection in an opaque liquid)."""
    have = {c.key for c in findings.candidates}
    blocks = [(p, f) for f in findings.findings for p in f.blocks]
    out = []
    for stream in sheet.streams:
        for app in kb.applications:
            if (app.get("domain") != sheet.domain or app.get("scope") != "process_application"
                    or stream.matrix.value not in ("unknown", app.get("matrix"))):
                continue
            for tid in app.get("techniques", []):
                tech = kb.techniques.get(tid)
                key = f"{stream.id}:{tech['method']}:{tid}" if tech else ""
                if not tech or not tech["in_line"] or key in have:
                    continue
                have.add(key)
                hits = [f for p, f in blocks if fnmatch(key, p)]
                ev, ev_ids = evidence_fit(tech["method"], tid, stream, sheet, kb)
                link, notes = link_fit(tech["method"], sheet.distance.value, kb)
                out.append(Candidate(
                    key=key, method=tech["method"], technique=tech["technique"], technique_id=tid,
                    stream_id=stream.id, fit=APPLICATION_FIT, optics=optics_fit(tech, stream.optics.value),
                    evidence=ev, link=link, blocked=bool(hits),
                    reasons=[*notes, *[f.message for f in hits]], evidence_ids=[tech["card"], *ev_ids]))
    return out


def with_application_candidates(findings: RuleFindings, sheet: RequirementsSheet, kb: KnowledgeBase) -> RuleFindings:
    """The engine's findings with application-evidence candidates added (status, findings and seeds unchanged)."""
    extra = evidence_led_candidates(sheet, findings, kb)
    if not extra:
        return findings
    merged = sorted([*findings.candidates, *extra], key=lambda c: (c.blocked, -c.score, c.key))
    return findings.model_copy(update={"candidates": merged})


# ---- recommendations

_ROLE_ORDER = {RecRole.PRIMARY: 0, RecRole.COMPARISON: 1, RecRole.CONDITIONAL: 2, RecRole.SCREENING: 3,
               RecRole.NOT_RECOMMENDED: 4}


def _shortlist(ranked: list[Candidate]) -> list[Candidate]:
    """Candidates worth recommending, best first. When the knowledge base has a same-domain process application,
    only evidence-backed techniques follow the lead (a second geometry of one method needs that backing too);
    in an open field every method is listed once."""
    if not ranked:
        return []
    lead = ranked[0]
    per_method: dict[str, int] = {}
    keep = []
    for c in ranked:
        strong = c.evidence >= STRONG_EVIDENCE
        if c is not lead and not strong and lead.evidence >= STRONG_EVIDENCE:
            continue
        if per_method.get(c.method, 0) >= (2 if strong else 1):
            continue
        per_method[c.method] = per_method.get(c.method, 0) + 1
        keep.append(c)
    return keep


def build_recommendations(sheet: RequirementsSheet, findings: RuleFindings, kb: KnowledgeBase) -> list[RecSkel]:
    """Methods, technique, role and scope for every recommendation, derived from the engine's candidates."""
    intended = RuleContext(sheet, kb).methods_intended()
    undefined = {f.stream_id for f in findings.findings if f.rule_id == "R-UNDEFINED-TARGET"}
    combine = any(f.rule_id == "R-COMBINATION" for f in findings.findings)
    status = findings.status
    rows: dict[tuple, dict] = {}

    def add(stream_id: str, methods: list[str], technique: str, role: RecRole, reasons: list[str],
            ids: list[str], blockers: list[str] | None = None) -> None:
        row = rows.setdefault((tuple(methods), technique, role),
                              {"applies": [], "reasons": [], "ids": [], "blockers": []})
        if stream_id not in row["applies"]:
            row["applies"].append(stream_id)
        row["reasons"] += [r for r in reasons if r not in row["reasons"]]
        row["ids"] += [i for i in ids if i not in row["ids"]]
        row["blockers"] += [i for i in (blockers or []) if i not in row["blockers"]]

    for s in sheet.streams:
        mine = sorted((c for c in findings.candidates if c.stream_id == s.id and not c.blocked),
                      key=lambda c: (-c.score, -c.evidence, c.key))
        ranked = _shortlist(mine)
        screening = status != DecisionStatus.PROVISIONAL or s.id in undefined or not ranked
        if screening:
            methods = [c.method for c in ranked[:3]] or list(FALLBACK_SCREEN)
            ids = [i for m in methods for i in method_cards(kb, m)] + [i for c in ranked[:3] for i in c.evidence_ids]
            why = (["The variable to be measured is not defined yet."] if s.id in undefined else
                   ["No method can be chosen yet; compare candidate methods on retained samples first."])
            add(s.id, methods, SCREEN_TECHNIQUE, RecRole.SCREENING, why, ids)
        if s.id not in undefined and status != DecisionStatus.OUTSIDE_SUPPORTED_SCOPE and ranked:
            lead = ranked[0]
            for i, c in enumerate(ranked[:MAX_PER_STREAM]):
                if status == DecisionStatus.INSUFFICIENT_INFORMATION:
                    if i >= 2:
                        break
                    role = RecRole.CONDITIONAL
                elif i == 0:
                    role = RecRole.PRIMARY
                elif c.optics > 0 and lead.score - c.score <= COMPARISON_MARGIN:
                    role = RecRole.COMPARISON
                else:
                    role = RecRole.CONDITIONAL
                add(s.id, [c.method], c.technique, role, list(c.reasons), [*c.evidence_ids, *method_cards(kb, c.method)])
            if combine and status == DecisionStatus.PROVISIONAL and len(ranked) >= 2:
                pair = [ranked[0].method, ranked[1].method]
                add(s.id, pair, COMBO_TECHNIQUE, RecRole.SCREENING,
                    ["Combining methods is a hypothesis to test after each method is assessed alone."],
                    [i for m in pair for i in method_cards(kb, m)])
        # Methods the client intends to use but the rules block: say so explicitly.
        for m in sorted(intended):
            if any(c.method == m and not c.blocked for c in findings.candidates if c.stream_id == s.id):
                continue
            blocked = sorted((c for c in findings.candidates if c.stream_id == s.id and c.method == m),
                             key=lambda c: (-c.score, c.key))
            if not blocked:
                continue
            c = blocked[0]
            hits = [f for f in findings.findings if any(fnmatch(c.key, p) for p in f.blocks)]
            blocking = [i for f in hits for i in f.evidence_ids]
            add(s.id, [m], c.technique, RecRole.NOT_RECOMMENDED, [f.message for f in hits] or list(c.reasons),
                [*blocking, *method_cards(kb, m)], blocking)

    def order(item):
        (methods, technique, role), _ = item
        lead = status != DecisionStatus.PROVISIONAL and technique == SCREEN_TECHNIQUE
        return (-1 if lead else _ROLE_ORDER[role], methods)

    recs = []
    for n, ((methods, technique, role), row) in enumerate(sorted(rows.items(), key=order), start=1):
        ids = list(dict.fromkeys(row["ids"]))
        fallback = [card_segment(c) for c in _afs_cards(kb, ids)[:2]]
        if role == RecRole.NOT_RECOMMENDED and row["reasons"]:
            fallback = [Segment(text=row["reasons"][0], claim_type=ClaimType.AFS,
                                evidence_ids=row["blockers"][:3] or ids[:1])]
        recs.append(RecSkel(id=f"r{n}", methods=list(methods), technique=technique, applies_to=row["applies"],
                            role=role, reasons=row["reasons"], evidence_ids=ids, fallback=fallback))
    return recs


# ---- premises

def build_premises(sheet: RequirementsSheet, findings: RuleFindings) -> list[PremiseSkel]:
    out = []
    for i, p in enumerate(sheet.premises):
        bound = [f for f in findings.findings if f.premise_index == i and f.premise_verdict is not None]
        verdict = max((f.premise_verdict for f in bound), key=lambda v: PREMISE_STRICTNESS[v],
                      default=PremiseVerdict.UNVERIFIABLE)
        out.append(PremiseSkel(id=f"p{i}", index=i, premise=p.text, verdict=verdict,
                               findings=[f.message for f in bound],
                               evidence_ids=list(dict.fromkeys(c for f in bound for c in f.evidence_ids))))
    return out


# ---- questions

QUESTION_TEMPLATES: dict[str, tuple[str, str]] = {
    "matrix": ("What is the physical state of the sample at the measurement point (liquid, powder, paste or solid)?",
               "The sample type decides which in-line techniques of the method table can be used at all."),
    "optics": (("Is the liquid clear, turbid or opaque at the measurement point, and does that change during the "
                "process?"),
               "The optical character decides between transmission, transflection and reflection or ATR geometries."),
    "targets": ("Which substance or quality variable must be detected or quantified?",
                "No method can be chosen before the variable to be measured is defined."),
    "distance": ("How far is the measurement point from the place where an analyzer could stand?",
                 "The link length limits which fibers and methods remain practical."),
    "use_context": ("Is the result meant for research, a pilot, production monitoring or batch release?",
                    "The intended use sets how strict the validation plan has to be."),
    "requested_certainty": ("Do you need a comparison of options, an approval, or an exact configuration?",
                            "A first assessment can compare options; it cannot approve a configuration."),
    "process_conditions": (("Which temperature, pressure, flow, build-up and cleaning conditions apply at the "
                            "measurement point?"),
                           "They decide the interface and the probe ratings to confirm."),
    "concentration_range": ("In which range must the target variable be followed?",
                            "The range decides whether the sensitivity of a method can be enough."),
    "accuracy_and_limits": (("Which accuracy or detection limit does the decision require, and how is it defined "
                             "today?"),
                            "Without it the experiment has no go or no-go criterion."),
    "response_time": ("How quickly must a result be available?",
                      "The response time limits the measurement and sampling set-up."),
    "reference_method": ("Which reference method gives the comparison values, and how large is its own error?",
                         "Models can only be as good as the reference values they are built on."),
    "location_access": ("Where can an interface be installed, and how is the point reached and cleaned?",
                        "Access and cleaning decide the probe geometry and the maintenance effort."),
    "acceptance": ("Which numerical acceptance criteria will the client agree before the first test?",
                   "A go or no-go decision needs criteria that are fixed before the data are seen."),
}
_GENERIC_QUESTIONS = ("acceptance", "reference_method", "accuracy_and_limits", "process_conditions")
_IMPACT_CHANGES = {
    "STATUS_CHANGE": "Whether a method can be chosen at all (the decision status)",
    "PRIMARY_METHOD_CHANGE": "Which method is recommended first",
    "TECHNIQUE_CHANGE": "Which probe geometry or interface is used",
    "RISK_ONLY": "The acceptance criteria and the feasibility plan"}
_IMPACT_WHY = {
    "STATUS_CHANGE": "The answer can change whether the assessment reaches a feasibility statement.",
    "PRIMARY_METHOD_CHANGE": "The answer can change which method is tried first.",
    "TECHNIQUE_CHANGE": "The answer can change the probe geometry or interface.",
    "RISK_ONLY": "The answer sharpens the acceptance criteria and the plan."}
_OUTCOME_METHODS = re.compile(r"methods:\s*(.*?)(?:;\s*techniques:|$)")


def _base_slot(slot: str) -> str:
    return re.sub(r"^streams\.[^.]+\.", "", slot)


def _decision_text(seed: QuestionSeed | None, impact: str) -> str:
    text = _IMPACT_CHANGES.get(impact, _IMPACT_CHANGES["RISK_ONLY"])
    if seed is not None and seed.outcomes:
        parts = []
        for value, outcome in list(seed.outcomes.items())[:3]:
            m = _OUTCOME_METHODS.search(outcome)
            parts.append(f"{value}: {m.group(1).strip() if m else outcome}")
        text += " (" + "; ".join(parts) + ")"
    return text


def _plan_only(q: ClarifyQuestion) -> bool:
    """A gate question whose answers only sharpen the feasibility plan (the engine's result does not move)."""
    return q.impact == "RISK_ONLY" and all(o.effect == NO_CHANGE or o.effect.startswith("plan:") for o in q.options)


def build_questions(sheet: RequirementsSheet, findings: RuleFindings, gate: list[ClarifyQuestion] | None = None,
                    covered: Callable[[str], bool] | None = None) -> list[QuestionSkel]:
    """3–6 clarification questions. The clarify gate's questions keep its value-of-information order (the order the
    scientist is asked in); the rule questions it does not cover join before the first gate question of a lower
    impact class, and before its plan-only ones. Wording comes from the ontology, the rule or an expert template."""
    streams = {s.id: s for s in sheet.streams}
    pending = sorted((q for q in findings.question_seeds if not (covered is not None and covered(q.slot))),
                     key=lambda q: IMPACT_ORDER.index(q.impact))
    merged: list[ClarifyQuestion | QuestionSeed] = []
    for q in gate or []:
        rank = IMPACT_ORDER.index(q.impact) + (0.5 if _plan_only(q) else 0)
        while pending and IMPACT_ORDER.index(pending[0].impact) < rank:
            merged.append(pending.pop(0))
        merged.append(q)
    merged += pending
    picked: list[tuple[str, ClarifyQuestion | QuestionSeed | None]] = []
    seen: set[str] = set()
    for q in merged:
        if q.slot not in seen and len(picked) < MAX_QUESTIONS:
            picked.append((q.slot, q))
            seen.add(q.slot)
    if len(picked) < MIN_QUESTIONS:
        for slot in sheet.unknown_slots():
            if len(picked) >= MIN_QUESTIONS:
                break
            if slot not in seen and (_base_slot(slot) in QUESTION_TEMPLATES):
                picked.append((slot, None))
                seen.add(slot)
        for base in _GENERIC_QUESTIONS:
            if len(picked) >= MIN_QUESTIONS:
                break
            if base not in seen:
                picked.append((base, None))
                seen.add(base)
    out = []
    for n, (slot, seed) in enumerate(picked, start=1):
        if isinstance(seed, ClarifyQuestion):
            out.append(QuestionSkel(id=f"q{n}", slot=slot, stream_id=seed.stream_id, priority=n, impact=seed.impact,
                                    decision_it_changes=decision_text(seed), question=seed.text, why=seed.why))
            continue
        base = _base_slot(slot)
        sid = slot.split(".")[1] if slot.startswith("streams.") else None
        template = QUESTION_TEMPLATES.get(base)
        hint = seed.text_hint.strip() if seed is not None and seed.text_hint else ""
        text = hint or (template[0] if template else f"Please provide details on: {base.replace('_', ' ')}.")
        if sid and len(streams) > 1 and sid in streams and not hint:
            text = text.rstrip("?.") + f" (stream {streams[sid].name})?"
        impact = seed.impact if seed is not None else "RISK_ONLY"
        out.append(QuestionSkel(
            id=f"q{n}", slot=slot, stream_id=sid, priority=n, impact=impact,
            decision_it_changes=_decision_text(seed, impact), question=text,
            why=(template[1] if template else _IMPACT_WHY.get(impact, _IMPACT_WHY["RISK_ONLY"]))))
    return out


# ---- measurement concept and spectral ranges

def build_ranges(recs: list[RecSkel], kb: KnowledgeBase) -> list[SpectralRange]:
    """Nominal ranges from the knowledge base. The caveats are the range cards' own claims (supported by
    construction) plus a statement of what the nominal range does not tell; writers may add caveats."""
    methods = list(dict.fromkeys(m for r in recs if r.role != RecRole.NOT_RECOMMENDED for m in r.methods))
    out = []
    for m in methods:
        if m not in kb.methods:
            continue
        r = spectral_range_for(m, kb)
        cards = _afs_cards(kb, kb.methods[m].get("range_cards", []))
        r.caveat = [card_segment(c) for c in cards[:2]] + [Segment(
            text="The usable range depends on the instrument, fiber and probe and is specified for the selected system.",
            claim_type=ClaimType.PROPOSAL)]
        if m == "Raman":
            r.caveat.append(Segment(
                text="State the excitation wavelength separately from the Raman shift and choose it with the sample's "
                     "fluorescence and the instrument in mind.", claim_type=ClaimType.PROPOSAL))
        out.append(r)
    return out


def _blocked_fibers(findings: RuleFindings, kb: KnowledgeBase) -> dict[str, set[str]]:
    """Fiber family -> methods it cannot carry, from blocking fiber-window findings (the client's existing cable)."""
    out: dict[str, set[str]] = {}
    for f in findings.findings:
        if f.rule_id == "R-FIBER-WINDOW" and f.severity == Severity.blocking:
            out.setdefault(f.data.get("fiber_family", ""), set()).add(f.data.get("method", ""))
    return out


def _geometry(r: RecSkel) -> str:
    head = " + ".join(r.methods)
    return r.technique if r.technique.lower().startswith(head.lower()) else f"{head} {r.technique}"


def build_concepts(sheet: RequirementsSheet, findings: RuleFindings, recs: list[RecSkel],
                   ranges: list[SpectralRange], kb: KnowledgeBase | None = None) -> list[ConceptSkel]:
    link = next((f for f in findings.findings if f.rule_id == "R-LINK-LENGTH"), None)
    blocked = _blocked_fibers(findings, kb) if kb is not None else {}
    names = {r.method: r.fiber_family_needed.split(", ") for r in ranges}
    out = []
    for s in sheet.streams:
        mine = [r for r in recs if s.id in r.applies_to and r.role != RecRole.NOT_RECOMMENDED]
        geometry = "; ".join(dict.fromkeys(_geometry(r) for r in mine)) or "to be defined after screening"
        fibers: list[str] = []
        for r in mine:
            for m in r.methods:
                ids = {name: fid for fid, name in fibers_for(m, kb)} if kb is not None else {}
                for name in names.get(m, []):
                    name = name.strip()
                    # The client's existing fiber cannot carry a method it was blocked for: do not name it again.
                    if ids.get(name) in blocked and m in blocked[ids[name]]:
                        name = f"new fiber link for {m}"
                    elif ids.get(name) in blocked:
                        name = f"fiber for the {m} range (type to be confirmed with AFS)"
                    if name not in fibers:
                        fibers.append(name)
        fiber = ", ".join(fibers) or "to be confirmed with AFS"
        if sheet.distance.value == "at_process":
            fiber += "; short link next to the process"
        elif link is not None:
            fiber += "; long link: confirm with AFS (documented for VIS-NIR cables, not for mid-IR fibers)"
        else:
            fiber += "; link length to be confirmed"
        loc = sheet.location_access.value if sheet.location_access.stated else \
            "measurement point to be agreed with the client"
        out.append(ConceptSkel(stream_id=s.id, probe_geometry=geometry, location=loc, fiber_link=fiber))
    return out


# ---- feasibility plan

PLAN_DEFAULTS = {
    "samples_and_states": "Collect representative samples across the client's range and the relevant physical "
                          "variation, for example temperature, particle size, turbidity, flow and fouling.",
    "reference_measurements": "Measure an independent reference for each target variable with a documented "
                              "uncertainty, time-aligned with the spectra.",
    "setup": "Start in the laboratory with the candidate methods and geometries side by side, then repeat under "
             "realistic process conditions.",
    "comparison": "Build single-method models first and combine methods only afterwards; compare prediction error "
                  "and bias with the client's requirement and separate physical effects from composition effects.",
    "validation": "Validate on held-out runs or batches, never on the calibration samples.",
    "go_no_go": "Agree numerical acceptance criteria with the client before testing and choose the simplest "
                "configuration that meets them on independent material.",
    "not_demonstrated": "This experiment does not show long-term process robustness, cleaning and fouling "
                        "behaviour, or performance on material that was not sampled.",
}
PLAN_STEPS = [
    "Clarify the open questions and agree numerical acceptance criteria with the client.",
    "Prepare representative samples with the relevant physical variation.",
    "Record spectra with each candidate together with independent, time-aligned reference results.",
    "Build single-method models first, then test any combination.",
    "Validate on held-out runs or batches against the agreed criteria.",
    "Decide go or no-go with the client and state what the experiment did not show.",
]
DECISION_BASIS = ("Agree numerical acceptance criteria with the client before the test and choose the simplest "
                  "configuration that meets them on independent material.")


def build_plan(sheet: RequirementsSheet, recs: list[RecSkel], questions: list[QuestionSkel]) -> PlanSkel:
    targets = list(dict.fromkeys(t.name for s in sheet.streams for t in s.targets)) or ["the target variable"]
    methods = list(dict.fromkeys(m for r in recs if r.role != RecRole.NOT_RECOMMENDED for m in r.methods))
    objective = (f"Decide whether {' and '.join(methods) or 'the candidate methods'} can follow "
                 f"{' and '.join(targets)} well enough to justify a process installation.")
    first = [q.question for q in questions[:2]]
    return PlanSkel(objective=objective, clarify_first=["numerical acceptance criteria", *first],
                    steps=list(PLAN_STEPS), defaults=dict(PLAN_DEFAULTS), decision_basis=DECISION_BASIS)


def build_skeleton(sheet: RequirementsSheet, findings: RuleFindings, kb: KnowledgeBase,
                   gate: list[ClarifyQuestion] | None = None,
                   covered: Callable[[str], bool] | None = None) -> Skeleton:
    """Everything code can decide before any writer runs. Deterministic: same engine result, same skeleton.
    `gate` is the clarify gate's ranked questions and `covered` tells which rule questions they replace."""
    recs = build_recommendations(sheet, findings, kb)
    ranges = build_ranges(recs, kb)
    questions = build_questions(sheet, findings, gate, covered)
    return Skeleton(
        status=findings.status, recs=recs, premises=build_premises(sheet, findings), questions=questions,
        concepts=build_concepts(sheet, findings, recs, ranges, kb), ranges=ranges,
        requirements=Requirements(stated_facts=stated_facts(sheet), key_unknowns=key_unknowns(sheet, findings)),
        plan=build_plan(sheet, recs, questions))


# ---------------------------------------------------------------- evidence slices

_TOPICS = {
    "concept": {"geometry", "fiber", "link_length", "spectral_range", "optics", "atr", "probes", "interference",
                "penetration", "units", "excitation", "sampling", "signal", "turbidity", "opaque", "clear",
                "transflection", "powder", "aqueous", "hot", "water", "remote"},
    "plan": {"screening", "method_selection", "timing", "calibration", "evidence_level", "chemometrics",
             "heterogeneity", "physical_variation", "risk", "service"},
}
_COMBINATION_TOPICS = {"combination", "data_fusion"}
SLICE_CAP, SLICE_FLOOR, EXT_CAP = 15, 8, 4


def slice_pack(pack: EvidencePack, sk: Skeleton, findings: RuleFindings, kb: KnowledgeBase) -> dict[str, list[Card]]:
    """One evidence slice per writer: the cards that bear on its section, 8–15 of them, plus verified web cards.
    Cards are weighted by what the skeleton and the findings need; ties keep the pack's order (mandatory first)."""
    order = {c.id: i for i, c in enumerate(pack.cards)}
    weights: dict[str, dict[str, float]] = {s: {} for s in SECTIONS}
    methods = set(sk.recommended_methods())
    combined = any(len(r.methods) > 1 for r in sk.recs)
    topics = {**_TOPICS, "plan": _TOPICS["plan"] | (_COMBINATION_TOPICS if combined else set())}

    def bump(section: str, ids, w: float) -> None:
        for cid in ids:
            if cid in order:
                weights[section][cid] = weights[section].get(cid, 0.0) + w

    def on_topic(c: Card) -> bool:
        """A card about a method nobody recommends only enters through a finding."""
        return not c.methods or "ALL" in c.methods or bool(set(c.methods) & methods)

    for r in sk.recs:
        bump("answer", r.evidence_ids, 3)
        bump("concept", r.evidence_ids, 1)
        bump("plan", [i for i in r.evidence_ids if kb.cards.get(i) and kb.cards[i].scope.value == "process_application"], 2)
    for f in findings.findings:
        if f.premise_verdict is not None or f.severity in (Severity.blocking, Severity.gate, Severity.premise):
            bump("answer", f.evidence_ids, 3)
            bump("plan", f.evidence_ids, 1)
        else:
            bump("concept", f.evidence_ids, 2)
        if f.question:
            bump("plan", f.evidence_ids, 3)
    for m in methods:
        mc = kb.methods.get(m, {})
        bump("concept", [*mc.get("range_cards", []), *mc.get("limitation_cards", []), *mc.get("general_cards", [])], 3)
        bump("answer", mc.get("limitation_cards", []), 2)
        bump("plan", mc.get("limitation_cards", []), 2)
    for c in pack.cards:
        if on_topic(c):
            for section, wanted in topics.items():
                if set(c.topics) & wanted:
                    bump(section, [c.id], 2 if section == "plan" else 1)
            if pack.reasons.get(c.id) == "search":
                bump("answer", [c.id], 1)
                bump("plan", [c.id], 1)
        if c.source == "EXT":
            for section in SECTIONS:
                bump(section, [c.id], 2)
    out: dict[str, list[Card]] = {}
    for section in SECTIONS:
        ranked = sorted(weights[section], key=lambda cid: (-weights[section][cid], order[cid]))
        ext = [cid for cid in ranked if pack.cards[order[cid]].source == "EXT"][:EXT_CAP]
        ids = [cid for cid in ranked if cid not in ext][:SLICE_CAP - len(ext)] + ext
        if len(ids) < SLICE_FLOOR:
            ids += [c.id for c in pack.cards if c.id not in ids][:SLICE_FLOOR - len(ids)]
        out[section] = [pack.cards[order[cid]] for cid in sorted(set(ids), key=lambda cid: order[cid])]
    return out


# ---------------------------------------------------------------- merge

_BRACKET = re.compile(r"\s*\[([^\[\]]{3,200})\]")
_CARD_ID = re.compile(r"^(?:S0\d|TABLE|EXT)-[\w.\-]+$")


def lift_card_ids(text: str) -> tuple[str, list[str]]:
    """Models often write citations into the sentence ("... [S01-p10-nir-range]") instead of the id field. Move
    bracketed card ids out of the text; brackets with anything else in them stay."""
    ids: list[str] = []

    def take_group(m: re.Match) -> str:
        parts = [t for t in re.split(r"[\s,;]+", m.group(1).strip()) if t]
        if parts and all(_CARD_ID.match(t) for t in parts):
            ids.extend(parts)
            return ""
        return m.group(0)

    clean = _BRACKET.sub(take_group, text)
    return re.sub(r"\s+([.,;:])", r"\1", clean).strip(), list(dict.fromkeys(ids))

_VERDICT_BY_STATUS = {DecisionStatus.PROVISIONAL: Verdict.CONDITIONAL,
                      DecisionStatus.INSUFFICIENT_INFORMATION: Verdict.NOT_YET,
                      DecisionStatus.OUTSIDE_SUPPORTED_SCOPE: Verdict.NOT_YET}


def clamp_verdict(verdict: Verdict, status: DecisionStatus) -> Verdict:
    """The engine's status caps the answer: a first assessment that is not provisional never says YES."""
    if status != DecisionStatus.PROVISIONAL and verdict == Verdict.YES:
        return Verdict.CONDITIONAL
    return verdict


@dataclass
class Merged:
    body: ReportBody
    dropped: dict[str, list[str]] = field(default_factory=dict)   # sentence text -> ids outside the writer's slice


def _is_afs(seg: Segment, kb: KnowledgeBase, known: dict[str, Card]) -> bool:
    return any((known.get(i) or kb.cards.get(i)) is not None and (known.get(i) or kb.cards[i]).source in AFS_SOURCES
               for i in seg.evidence_ids)


def merge(sk: Skeleton, kb: KnowledgeBase, pack: EvidencePack, drafts: dict[str, BaseModel | None],
          slices: dict[str, list[Card]] | None = None, guard: NumberGuard | None = None) -> Merged:
    """Skeleton + writer prose -> a valid ReportBody. A citation outside the writer's slice is removed from its
    sentence and recorded in `dropped`; anything a writer left out is filled by code."""
    known = {c.id: c for c in pack.cards}
    allowed = {s: {c.id for c in cards} for s, cards in (slices or {}).items()}
    dropped: dict[str, list[str]] = {}

    def free(text: str, fallback: str) -> str:
        """A writer's free string (no citations) is kept only if every number in it comes from the enquiry or code."""
        text = lift_card_ids(text)[0]
        return text if text and not (guard is not None and guard.bad(text)) else fallback

    def take(segments: list[Segment], section: str) -> list[Segment]:
        out = []
        for seg in segments:
            text, lifted = lift_card_ids(seg.text)
            if not text:
                continue
            ids = list(dict.fromkeys([*seg.evidence_ids, *lifted]))
            keep = [i for i in ids if i in allowed[section]] if section in allowed else ids
            new = Segment(text=text, claim_type=seg.claim_type, evidence_ids=keep)
            if len(keep) != len(ids):
                dropped[text] = [i for i in ids if i not in keep]
            out.append(new)
        return out

    a: AnswerSection | None = drafts.get("answer")
    c: ConceptSection | None = drafts.get("concept")
    p: PlanSection | None = drafts.get("plan")

    # ---- section A
    rec_prose = {r.rec_id: r for r in (a.recommendations if a else [])}
    recs = []
    for rs in sk.recs:
        prose = rec_prose.get(rs.id)
        rationale = take(prose.rationale, "answer") if prose else []
        conditions = take(prose.conditions, "answer") if prose else []
        limitations = take(prose.limitations, "answer") if prose else []
        if not rationale:
            rationale = [s.model_copy(deep=True) for s in rs.fallback] or [Segment(
                text="Not supported by the available sources; to be confirmed with AFS.",
                claim_type=ClaimType.ASSUMPTION)]
        if rs.role != RecRole.NOT_RECOMMENDED and not any(
                _is_afs(s, kb, known) for s in (*rationale, *conditions, *limitations)):
            rationale += [s.model_copy(deep=True) for s in rs.fallback[:1]]
        recs.append(Recommendation(methods=rs.methods, technique=rs.technique, applies_to=rs.applies_to,
                                   role=rs.role, rationale=rationale, conditions=conditions,
                                   limitations=limitations))
    premise_prose = {x.premise_id: x for x in (a.premise_checks if a else [])}
    premises = []
    for ps in sk.premises:
        expl = take(premise_prose[ps.id].explanation, "answer") if ps.id in premise_prose else []
        if not expl:
            expl = ([Segment(text=ps.findings[0], claim_type=ClaimType.AFS, evidence_ids=ps.evidence_ids[:3])]
                    if ps.findings and ps.evidence_ids else
                    [Segment(text="The supplied materials do not settle this; to be confirmed with AFS.",
                             claim_type=ClaimType.UNKNOWN)])
        premises.append(PremiseCheck(premise=ps.premise, verdict=ps.verdict, explanation=expl))
    answer_segs = take(a.direct_answer, "answer") if a else []
    if not answer_segs:
        answer_segs = [Segment(text="A first feasibility experiment on representative samples is the next step; "
                                    "the open questions below decide how far the recommendation can be trusted.",
                               claim_type=ClaimType.PROPOSAL)]
    verdict = clamp_verdict(a.verdict, sk.status) if a else _VERDICT_BY_STATUS[sk.status]

    # ---- section B
    concept_prose = {x.stream_id: x for x in (c.concepts if c else [])}
    concepts = []
    for cs in sk.concepts:
        notes = take(concept_prose[cs.stream_id].notes, "concept") if cs.stream_id in concept_prose else []
        concepts.append(MeasurementConcept(stream_id=cs.stream_id, probe_geometry=cs.probe_geometry,
                                           location=cs.location, fiber_link=cs.fiber_link, notes=notes))
    caveat_prose = {x.method: x for x in (c.spectral_caveats if c else [])}
    ranges = []
    for r in sk.ranges:
        r = r.model_copy(deep=True)
        if r.method in caveat_prose:
            r.caveat += take(caveat_prose[r.method].caveats, "concept")
        ranges.append(r)
    risks = [Risk(risk=segs, effect=free(x.effect, "Not quantified."), mitigation=free(x.mitigation, "To be agreed."))
             for x in (c.risks if c else []) if (segs := take(x.risk, "concept"))]
    assumptions = [Assumption(assumption=free(x.assumption, ""), to_confirm_with=free(x.to_confirm_with, "the client"))
                   for x in (c.assumptions if c else []) if free(x.assumption, "")]

    # ---- section C
    q_prose = {x.question_id: x for x in (p.questions if p else [])}
    questions = []
    for qs in sk.questions:
        x = q_prose.get(qs.id)
        questions.append(Question(question=free(x.question, qs.question) if x else qs.question,
                                  priority=qs.priority, decision_it_changes=qs.decision_it_changes,
                                  why_it_matters=qs.why))
    prose = p.plan if p else PlanProse()
    elements = {}
    for name in PLAN_ELEMENTS:
        segs = take(getattr(prose, name), "plan")
        elements[name] = segs or [Segment(text=sk.plan.defaults[name], claim_type=ClaimType.PROPOSAL)]
    steps = [t.strip() for t in prose.steps if t.strip()]
    if any(guard is not None and guard.bad(t) for t in steps):
        steps = []
    plan = FeasibilityPlan(objective=free(prose.objective, sk.plan.objective), clarify_first=sk.plan.clarify_first,
                           steps=steps if 1 <= len(steps) <= 6 else list(sk.plan.steps), **elements)
    basis = take(p.decision_basis, "plan") if p else []
    basis = basis or [Segment(text=sk.plan.decision_basis, claim_type=ClaimType.PROPOSAL)]

    body = ReportBody(
        decision_status=sk.status, direct_answer=DirectAnswer(verdict=verdict, text=answer_segs),
        premise_checks=premises, requirements=sk.requirements.model_copy(deep=True),
        clarification_questions=questions, recommendations=recs, measurement_concept=concepts,
        spectral_ranges=ranges, risks=risks, assumptions=assumptions, feasibility_plan=plan, decision_basis=basis)
    return Merged(body=body, dropped=dropped)


def slice_issues(merged: Merged) -> list[tuple[str, str]]:
    """(path, message) for every sentence that cited a card outside its writer's slice."""
    note = "outside the evidence given to its writer; citation removed"
    return [(path, f"cites {', '.join(merged.dropped[seg.text])}, {note}")
            for path, seg in iter_segments(merged.body) if seg.text in merged.dropped]


def ensure_afs(body: ReportBody, sk: Skeleton, kb: KnowledgeBase, pack: EvidencePack | None = None) -> ReportBody:
    """Every recommended method keeps at least one AFS citation, even after failing sentences were removed."""
    known = {c.id: c for c in (pack.cards if pack else [])}
    for rec, rs in zip(body.recommendations, sk.recs, strict=False):
        if rec.role == RecRole.NOT_RECOMMENDED:
            continue
        if not any(_is_afs(s, kb, known) for s in (*rec.rationale, *rec.conditions, *rec.limitations)):
            rec.rationale = [*rec.rationale, *(s.model_copy(deep=True) for s in rs.fallback[:1])]
    return body


def fallback_sections(sk: Skeleton, kb: KnowledgeBase) -> dict[str, BaseModel]:
    """Writer-shaped prose built from card claims and the plan template alone (no model). Used as the reference
    'perfect writer' in tests and as the definition of what a section must contain."""
    answer = AnswerSection(
        recommendations=[RecProse(rec_id=r.id, rationale=[s.model_copy(deep=True) for s in r.fallback])
                         for r in sk.recs],
        premise_checks=[], direct_answer=[Segment(
            text="A first feasibility experiment on representative samples is the next step.",
            claim_type=ClaimType.PROPOSAL)], verdict=_VERDICT_BY_STATUS[sk.status])
    concept = ConceptSection(
        concepts=[ConceptProse(stream_id=c.stream_id, notes=[Segment(
            text="Test the interface on representative laboratory samples before specifying an installation.",
            claim_type=ClaimType.PROPOSAL)]) for c in sk.concepts],
        risks=[RiskProse(risk=[Segment(text="Physical variation of the sample can mimic composition changes.",
                                       claim_type=ClaimType.ASSUMPTION)],
                         effect="Biased predictions.", mitigation="Vary the physical conditions in the test design.")])
    plan = PlanSection(
        questions=[QuestionProse(question_id=q.id, question=q.question) for q in sk.questions],
        plan=PlanProse(objective=sk.plan.objective, steps=list(sk.plan.steps)),
        decision_basis=[Segment(text=sk.plan.decision_basis, claim_type=ClaimType.PROPOSAL)])
    return {"answer": answer, "concept": concept, "plan": plan}


def finding_lines(findings: RuleFindings) -> list[Finding]:
    """Findings in prompt order: those that bind the writers first, information last."""
    rank = {Severity.gate: 0, Severity.blocking: 0, Severity.premise: 1, Severity.warning: 2, Severity.info: 3}
    return sorted(findings.findings, key=lambda f: rank[f.severity])
