"""Shared data contracts for every PRISM stage.

Field names are part of the JSON contract with the UI (frontend/src/types.ts mirrors them).
"""
from __future__ import annotations

import re
from collections.abc import Iterator
from enum import Enum
from typing import ClassVar, Literal

from pydantic import BaseModel, Field, field_validator

MATRIX = ("liquid", "powder", "paste", "solid", "tissue", "gas", "unknown")
OPTICS = ("clear", "turbid", "opaque", "scattering", "variable", "unknown")
DISTANCE = ("at_process", "adjacent_room", "remote", "unknown")
USE_CONTEXT = ("r_and_d", "pilot", "production", "clinical", "unknown")
CERTAINTY = ("explore", "compare", "approve", "exact_config", "unknown")
DOMAINS = ("pharma", "dairy_food", "bioprocess", "petrochemical", "polymer", "medical", "environmental", "other")
PREMISE_TYPES = ("reuse_asset", "transfer_calibration", "method_preselected", "quote_as_proof",
                 "approve_concept", "immediate_exact_config", "other")
ASSET_KINDS = ("instrument", "fiber", "calibration", "reference_method", "other")
METHODS = ("NIR", "MIR", "Raman", "UV-Vis", "Fluorescence")
# Canonical method names; guided decoding enforces the enum in report fields.
MethodName = Literal["NIR", "MIR", "Raman", "UV-Vis", "Fluorescence"]
# Quote carried by a fact the scientist confirmed in the conversation. It is never a client quote.
CONFIRMED_QUOTE = "confirmed in conversation"


class ClaimType(str, Enum):
    CLIENT = "CLIENT"
    AFS = "AFS"
    EXTERNAL = "EXTERNAL"
    ASSUMPTION = "ASSUMPTION"
    PROPOSAL = "PROPOSAL"
    UNKNOWN = "UNKNOWN"


class DecisionStatus(str, Enum):
    PROVISIONAL = "PROVISIONAL"
    INSUFFICIENT_INFORMATION = "INSUFFICIENT_INFORMATION"
    OUTSIDE_SUPPORTED_SCOPE = "OUTSIDE_SUPPORTED_SCOPE"


_STRICTNESS = {DecisionStatus.PROVISIONAL: 0, DecisionStatus.INSUFFICIENT_INFORMATION: 1,
               DecisionStatus.OUTSIDE_SUPPORTED_SCOPE: 2}


def stricter(a: DecisionStatus, b: DecisionStatus) -> DecisionStatus:
    return a if _STRICTNESS[a] >= _STRICTNESS[b] else b


def is_looser(candidate: DecisionStatus, reference: DecisionStatus) -> bool:
    return _STRICTNESS[candidate] < _STRICTNESS[reference]


class Verdict(str, Enum):
    YES = "YES"
    NO = "NO"
    NOT_YET = "NOT_YET"
    CONDITIONAL = "CONDITIONAL"
    NOT_APPLICABLE = "NOT_APPLICABLE"


class PremiseVerdict(str, Enum):
    SUPPORTED = "SUPPORTED"
    CONTRADICTED = "CONTRADICTED"
    UNVERIFIABLE = "UNVERIFIABLE"


PREMISE_STRICTNESS = {PremiseVerdict.SUPPORTED: 0, PremiseVerdict.UNVERIFIABLE: 1, PremiseVerdict.CONTRADICTED: 2}


class RecRole(str, Enum):
    PRIMARY = "PRIMARY"
    COMPARISON = "COMPARISON"
    CONDITIONAL = "CONDITIONAL"
    SCREENING = "SCREENING"
    NOT_RECOMMENDED = "NOT_RECOMMENDED"


class Scope(str, Enum):
    method_general = "method_general"
    process_application = "process_application"
    lab_study = "lab_study"
    in_vitro_poc = "in_vitro_poc"
    business_context = "business_context"
    external = "external"


class Severity(str, Enum):
    info = "info"
    warning = "warning"
    premise = "premise"
    blocking = "blocking"
    gate = "gate"


class ScopeLabel(str, Enum):
    IN_SCOPE = "IN_SCOPE"
    PARTIAL = "PARTIAL"
    OFF_TOPIC = "OFF_TOPIC"
    UNSAFE = "UNSAFE"


# ---------------------------------------------------------------- enquiry and requirements

class Segment(BaseModel):
    text: str = Field(min_length=1)
    claim_type: ClaimType
    evidence_ids: list[str] = Field(default_factory=list)


class Enquiry(BaseModel):
    case_id: str
    title: str = ""
    text: str
    sha256: str
    origin: Literal["ui", "case_file", "chat"] = "ui"


class Fact(BaseModel):
    value: str = Field("unknown", description="Normalised value, or 'unknown' when the client did not say it")
    quote: str | None = Field(None, description="Exact words from the enquiry that state this value")

    @property
    def stated(self) -> bool:
        return self.value != "unknown" and bool(self.quote)

    @property
    def confirmed(self) -> bool:
        """Stated in the conversation by the scientist (provenance), not quoted from the client's enquiry."""
        return self.stated and self.quote == CONFIRMED_QUOTE


def _check(fact: Fact, allowed: tuple[str, ...], name: str) -> Fact:
    if fact.value not in allowed:
        raise ValueError(f"{name} must be one of {allowed}, got {fact.value!r}")
    return fact


class Target(BaseModel):
    name: str
    defined: bool = Field(True, description="False when the client cannot yet name the substance or variable")
    quote: str


class Stream(BaseModel):
    id: str = "s1"
    name: str = "main"
    targets: list[Target] = Field(default_factory=list)
    matrix: Fact = Field(default_factory=Fact, description=f"value one of {MATRIX}")
    optics: Fact = Field(default_factory=Fact, description=f"value one of {OPTICS}")

    @field_validator("matrix")
    @classmethod
    def _matrix(cls, v: Fact) -> Fact:
        return _check(v, MATRIX, "matrix")

    @field_validator("optics")
    @classmethod
    def _optics(cls, v: Fact) -> Fact:
        return _check(v, OPTICS, "optics")


class Asset(BaseModel):
    kind: str = Field(description=f"one of {ASSET_KINDS}")
    description: str
    method: str | None = Field(None, description=f"one of {METHODS} if the asset belongs to a method")
    fiber_family: str | None = Field(None, description="fiber id from kb/graph/fibers.yaml if known")
    quote: str

    @field_validator("kind")
    @classmethod
    def _kind(cls, v: str) -> str:
        if v not in ASSET_KINDS:
            raise ValueError(f"kind must be one of {ASSET_KINDS}")
        return v


class Premise(BaseModel):
    type: str = Field(description=f"one of {PREMISE_TYPES}")
    text: str
    method: str | None = None
    quote: str

    @field_validator("type")
    @classmethod
    def _type(cls, v: str) -> str:
        if v not in PREMISE_TYPES:
            raise ValueError(f"type must be one of {PREMISE_TYPES}")
        return v


class Interpretation(BaseModel):
    term: str = Field(description="Verbatim term from the enquiry")
    canonical: str | None = None
    kind: Literal["method", "technique", "fiber", "matrix", "optics", "unit", "other"] = "other"
    how: Literal["exact", "fuzzy", "embedding", "llm", "context"] = "llm"
    alternatives: list[str] = Field(default_factory=list)
    ambiguous: bool = False


class RequirementsSheet(BaseModel):
    GLOBAL_FACTS: ClassVar[tuple[str, ...]] = (
        "distance", "use_context", "requested_certainty", "process_conditions", "concentration_range",
        "accuracy_and_limits", "response_time", "reference_method", "location_access")

    client_question: list[str] = Field(default_factory=list)
    streams: list[Stream] = Field(min_length=1)
    distance: Fact = Field(default_factory=Fact, description=f"value one of {DISTANCE}")
    use_context: Fact = Field(default_factory=Fact, description=f"value one of {USE_CONTEXT}")
    requested_certainty: Fact = Field(default_factory=Fact, description=f"value one of {CERTAINTY}")
    process_conditions: Fact = Field(default_factory=Fact)
    concentration_range: Fact = Field(default_factory=Fact)
    accuracy_and_limits: Fact = Field(default_factory=Fact)
    response_time: Fact = Field(default_factory=Fact)
    reference_method: Fact = Field(default_factory=Fact)
    location_access: Fact = Field(default_factory=Fact)
    existing_assets: list[Asset] = Field(default_factory=list)
    premises: list[Premise] = Field(default_factory=list)
    interpretations: list[Interpretation] = Field(default_factory=list)
    domain: str = Field("other", description=f"one of {DOMAINS}")

    @field_validator("distance")
    @classmethod
    def _distance(cls, v: Fact) -> Fact:
        return _check(v, DISTANCE, "distance")

    @field_validator("use_context")
    @classmethod
    def _use(cls, v: Fact) -> Fact:
        return _check(v, USE_CONTEXT, "use_context")

    @field_validator("requested_certainty")
    @classmethod
    def _certainty(cls, v: Fact) -> Fact:
        return _check(v, CERTAINTY, "requested_certainty")

    @field_validator("domain")
    @classmethod
    def _domain(cls, v: str) -> str:
        if v not in DOMAINS:
            raise ValueError(f"domain must be one of {DOMAINS}")
        return v

    def unknown_slots(self) -> list[str]:
        out = [name for name in self.GLOBAL_FACTS if not getattr(self, name).stated]
        for s in self.streams:
            if not s.matrix.stated:
                out.append(f"streams.{s.id}.matrix")
            if not s.optics.stated:
                out.append(f"streams.{s.id}.optics")
            if not s.targets:
                out.append(f"streams.{s.id}.targets")
        return out

    def with_value(self, slot: str, value: str) -> RequirementsSheet:
        """Copy with one slot set to a hypothetical value (used by counterfactual question ranking)."""
        clone = self.model_copy(deep=True)
        fact = Fact(value=value, quote="[hypothetical]")
        if slot.startswith("streams."):
            _, sid, field = slot.split(".")
            stream = next(s for s in clone.streams if s.id == sid)
            setattr(stream, field, fact)
        else:
            setattr(clone, slot, fact)
        return clone


# ---------------------------------------------------------------- knowledge and engine

class WebStatus(str, Enum):
    VERIFIED = "VERIFIED"
    UNVERIFIED = "UNVERIFIED"
    UNREACHABLE = "UNREACHABLE"
    BLOCKED = "BLOCKED"


DOMAIN_TIERS = ("peer_reviewed", "standards", "vendor", "general")


class Verification(BaseModel):
    """Outcome of the deterministic checks on one web source and one quote (prism/web/verify.py)."""
    status: WebStatus
    checks: dict[str, bool] = Field(default_factory=dict)
    match_kind: Literal["exact", "fuzzy", "none"] = "none"
    match_score: float = 0.0
    domain: str = ""
    domain_tier: Literal["peer_reviewed", "standards", "vendor", "general"] = "general"
    content_sha256: str = ""
    retrieved_at: str = ""
    url: str = ""
    doi: str | None = None
    notes: list[str] = Field(default_factory=list)

    @property
    def verified(self) -> bool:
        return self.status == WebStatus.VERIFIED


class Card(BaseModel):
    id: str
    source: Literal["S01", "S02", "S03", "S04", "S05", "TABLE", "EXT", "UPLOAD", "WEB", "MCP", "MCP_LIVE"]
    page: int
    quote: str
    claim: str
    scope: Scope
    methods: list[str] = Field(default_factory=list)
    topics: list[str] = Field(default_factory=list)
    status: Literal["draft", "seed", "accepted", "rejected", "web_verified"] = "draft"
    url: str | None = None
    retrieved_at: str | None = None
    reviewed_by: str | None = None
    doi: str | None = None
    verification: Verification | None = None

    title: str | None = None
    provenance: dict = Field(default_factory=dict)

    def citation(self) -> str:
        if self.source in ("UPLOAD", "MCP", "MCP_LIVE"):
            label = {"UPLOAD": "Uploaded", "MCP": "Imported through MCP", "MCP_LIVE": "Live MCP result"}[self.source]
            return f"{label}: {self.title or self.id} p.{self.page}"
        if self.source == "WEB":
            from urllib.parse import urlsplit
            return f"Web: {urlsplit(self.url or '').hostname or self.title} (retrieved {(self.retrieved_at or '')[:10]}) p.{self.page}"
        if self.source == "TABLE":
            return "S01 Table 1 (p.6)"
        if self.source == "EXT":
            return f"[EXT] {self.url}"
        return f"{self.source} p.{self.page}"


class Finding(BaseModel):
    rule_id: str
    severity: Severity
    message: str
    evidence_ids: list[str] = Field(default_factory=list)
    stream_id: str | None = None
    blocks: list[str] = Field(default_factory=list, description="fnmatch patterns over candidate keys")
    premise_index: int | None = None
    premise_verdict: PremiseVerdict | None = None
    status: DecisionStatus | None = None
    question: str | None = None
    question_impact: str | None = None
    slots_read: list[str] = Field(default_factory=list)
    data: dict[str, str] = Field(default_factory=dict)


class Candidate(BaseModel):
    key: str
    method: str
    technique: str
    technique_id: str
    stream_id: str
    fit: float
    optics: float
    evidence: float
    link: float
    blocked: bool = False
    reasons: list[str] = Field(default_factory=list)
    evidence_ids: list[str] = Field(default_factory=list)

    @property
    def score(self) -> float:
        return self.fit + self.optics + self.evidence + self.link


class QuestionSeed(BaseModel):
    slot: str
    impact: Literal["STATUS_CHANGE", "PRIMARY_METHOD_CHANGE", "TECHNIQUE_CHANGE", "RISK_ONLY"]
    outcomes: dict[str, str] = Field(default_factory=dict)
    rule_ids: list[str] = Field(default_factory=list)
    text_hint: str = ""


class RuleFindings(BaseModel):
    findings: list[Finding] = Field(default_factory=list)
    candidates: list[Candidate] = Field(default_factory=list)
    question_seeds: list[QuestionSeed] = Field(default_factory=list)
    status: DecisionStatus = DecisionStatus.PROVISIONAL

    def top(self, stream_id: str, n: int = 2) -> list[Candidate]:
        pool = [c for c in self.candidates if c.stream_id == stream_id and not c.blocked]
        return sorted(pool, key=lambda c: (-c.score, c.key))[:n]


class ClarifyOption(BaseModel):
    """One answer a scientist can click. `effect` is what the engine's what-if says it would change."""
    value: str
    label: str
    effect: str


class ClarifyQuestion(BaseModel):
    """A ranked question of the clarify gate; its options come from the slot ontology (kb/ontology.yaml)."""
    id: str
    slot: str
    stream_id: str | None = None
    text: str
    why: str
    impact: Literal["STATUS_CHANGE", "PRIMARY_METHOD_CHANGE", "TECHNIQUE_CHANGE", "RISK_ONLY"]
    multi: bool = False
    options: list[ClarifyOption] = Field(min_length=2, max_length=5)


class WebSourceRecord(BaseModel):
    """One web source the run looked at: kept (card_id set) or rejected (reason says why)."""
    title: str = ""
    url: str
    doi: str | None = None
    provider: str = ""
    year: int | None = None
    verification: Verification | None = None
    card_id: str | None = None
    reason: str = ""


class WebReport(BaseModel):
    enabled: bool = False
    queries: list[str] = Field(default_factory=list)
    considered: int = 0
    sources: list[WebSourceRecord] = Field(default_factory=list)


class EvidencePack(BaseModel):
    cards: list[Card] = Field(default_factory=list)
    reasons: dict[str, str] = Field(default_factory=dict)

    def ids(self) -> set[str]:
        return {c.id for c in self.cards}


class ScopeDecision(BaseModel):
    label: ScopeLabel
    reason: str
    suggestions: list[str] = Field(default_factory=list)
    tier: Literal["signals", "embeddings", "classifier"] = "signals"


# ---------------------------------------------------------------- report

class DirectAnswer(BaseModel):
    verdict: Verdict
    text: list[Segment] = Field(min_length=1)


class PremiseCheck(BaseModel):
    premise: str
    verdict: PremiseVerdict
    explanation: list[Segment] = Field(min_length=1)


class StatedFact(BaseModel):
    slot: str
    value: str
    quote: str
    stream_id: str | None = None
    provenance: Literal["client", "confirmed"] = "client"


class Unknown(BaseModel):
    slot: str
    why_it_matters: str
    stream_id: str | None = None


class Requirements(BaseModel):
    stated_facts: list[StatedFact] = Field(default_factory=list)
    key_unknowns: list[Unknown] = Field(default_factory=list)


class Question(BaseModel):
    question: str
    priority: int
    decision_it_changes: str
    why_it_matters: str


class Recommendation(BaseModel):
    methods: list[MethodName] = Field(min_length=1, description="1 = single method, 2+ = combination")
    technique: str
    applies_to: list[str] = Field(default_factory=lambda: ["s1"])
    role: RecRole
    rationale: list[Segment] = Field(min_length=1)
    conditions: list[Segment] = Field(default_factory=list)
    limitations: list[Segment] = Field(default_factory=list)
    evidence_strength: str | None = Field(None, description="Filled by code; leave empty")


class MeasurementConcept(BaseModel):
    stream_id: str = "s1"
    probe_geometry: str
    location: str
    fiber_link: str
    notes: list[Segment] = Field(default_factory=list)


_EXCITATION = re.compile(r"\s*(\d{3,4}(?:[.,]\d+)?)\s*(?:nm)?\s*", re.IGNORECASE)


class SpectralRange(BaseModel):
    method: MethodName
    nominal_range: str
    units: str
    excitation_nm: float | None = Field(None, description="Laser excitation wavelength in nm; null when not chosen")
    fiber_family_needed: str
    caveat: list[Segment] = Field(default_factory=list)

    @field_validator("excitation_nm", mode="before")
    @classmethod
    def _excitation_is_a_number(cls, v: object) -> float | None:
        """A number of nanometres or null. Free text (a model dump that leaked into the field) becomes null."""
        if isinstance(v, bool):
            return None
        if isinstance(v, (int, float)):
            return float(v) if v > 0 else None
        if isinstance(v, str) and (m := _EXCITATION.fullmatch(v)):
            return float(m.group(1).replace(",", "."))
        return None


class Risk(BaseModel):
    risk: list[Segment] = Field(min_length=1)
    effect: str
    mitigation: str


class Assumption(BaseModel):
    assumption: str
    to_confirm_with: str


class FeasibilityPlan(BaseModel):
    objective: str
    clarify_first: list[str] = Field(default_factory=list)
    samples_and_states: list[Segment] = Field(default_factory=list)
    reference_measurements: list[Segment] = Field(default_factory=list)
    setup: list[Segment] = Field(default_factory=list)
    comparison: list[Segment] = Field(default_factory=list)
    validation: list[Segment] = Field(default_factory=list)
    go_no_go: list[Segment] = Field(default_factory=list)
    not_demonstrated: list[Segment] = Field(default_factory=list)
    steps: list[str] = Field(min_length=1)


class ReportBody(BaseModel):
    decision_status: DecisionStatus
    direct_answer: DirectAnswer
    premise_checks: list[PremiseCheck] = Field(default_factory=list)
    requirements: Requirements = Field(default_factory=Requirements)
    clarification_questions: list[Question] = Field(default_factory=list)
    recommendations: list[Recommendation] = Field(min_length=1)
    measurement_concept: list[MeasurementConcept] = Field(min_length=1)
    spectral_ranges: list[SpectralRange] = Field(default_factory=list)
    risks: list[Risk] = Field(default_factory=list)
    assumptions: list[Assumption] = Field(default_factory=list)
    feasibility_plan: FeasibilityPlan
    decision_basis: list[Segment] = Field(min_length=1)


class SourceRef(BaseModel):
    source: str | None = None
    title: str | None = None
    provenance: dict = Field(default_factory=dict)
    id: str
    citation: str
    quote: str
    scope: Scope
    url: str | None = None
    doi: str | None = None
    verification: Verification | None = None


class AssessmentReport(ReportBody):
    case_id: str
    title: str = ""
    input_sha256: str
    run_id: str
    created_at: str
    kb_version: str
    profile: str
    model_ids: dict[str, str] = Field(default_factory=dict)
    prompt_hashes: dict[str, str] = Field(default_factory=dict)
    client_question: list[str] = Field(default_factory=list)
    streams: list[Stream] = Field(default_factory=list)
    interpretations: list[Interpretation] = Field(default_factory=list)
    sources: list[SourceRef] = Field(default_factory=list)
    compliance: dict[str, bool] = Field(default_factory=dict)


# ---------------------------------------------------------------- verification and runs

class Issue(BaseModel):
    check_id: str
    path: str
    message: str
    severity: Literal["error", "warning"] = "error"


class ClaimVerdict(BaseModel):
    path: str
    verdict: Literal["supported", "partial", "unsupported", "scope_exceeded"]
    reason: str = ""


class CriticResult(BaseModel):
    verdicts: list[ClaimVerdict] = Field(default_factory=list)
    direct_answer_responsive: bool = True
    in_scope: bool = True


class VerificationReport(BaseModel):
    issues: list[Issue] = Field(default_factory=list)
    verdicts: list[ClaimVerdict] = Field(default_factory=list)
    judge_model: str = ""

    @property
    def passed(self) -> bool:
        return not any(i.severity == "error" for i in self.issues)


class RunManifest(BaseModel):
    run_id: str
    case_id: str
    input_sha256: str
    kb_version: str
    profile: str
    model_ids: dict[str, str] = Field(default_factory=dict)
    prompt_hashes: dict[str, str] = Field(default_factory=dict)
    git_commit: str = ""
    started_at: str = ""
    finished_at: str = ""
    timings: dict[str, float] = Field(default_factory=dict)
    flags: dict[str, str] = Field(default_factory=dict)
    output_sha256: str | None = None


def iter_segments(obj: object, path: str = "") -> Iterator[tuple[str, Segment]]:
    """Yield (path, segment) for every Segment inside a model, e.g. 'recommendations[0].rationale[1]'."""
    if isinstance(obj, Segment):
        yield path, obj
    elif isinstance(obj, BaseModel):
        for name in type(obj).model_fields:
            yield from iter_segments(getattr(obj, name), f"{path}.{name}" if path else name)
    elif isinstance(obj, list):
        for i, item in enumerate(obj):
            yield from iter_segments(item, f"{path}[{i}]")
