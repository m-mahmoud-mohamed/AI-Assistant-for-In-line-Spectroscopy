"""The clarify gate (docs/ASSISTANT_ARCHITECTURE.md §B.6): which unknowns are worth asking about, and what each answer
would change.

    Ontology            kb/ontology.yaml: the slots a scientist can answer, their questions, options and expert priors
    rank_questions      value of information: run the engine once per option of every open slot (a hypothetical copy
                        of the sheet) and rank the slots by how much the outcome moves. Code only, no model call.
    apply_confirmed     the facts confirmed in conversation, applied to a copy of the sheet. The what-if and the real
                        answer use this one function, so an option's effect is what answering it really does.
    map_text            "Other..." free text to an allowed value, one small call to the classifier role

Impact classes, most significant first: STATUS_CHANGE (the decision status), PRIMARY_METHOD_CHANGE, TECHNIQUE_CHANGE
(probe geometry, the shortlist or the blocked candidates), RISK_ONLY (findings or premise verdicts). The score of a
question is the sum over its options of prior(option) x weight(class of the change that option causes).
"""
from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import yaml
from pydantic import BaseModel, Field

from prism.kb.loader import KnowledgeBase
from prism.llm.prompts import render
from prism.rules.engine import IMPACT_ORDER
from prism.schemas import (
    CERTAINTY,
    CONFIRMED_QUOTE,
    DISTANCE,
    DOMAINS,
    MATRIX,
    OPTICS,
    USE_CONTEXT,
    ClarifyOption,
    ClarifyQuestion,
    DecisionStatus,
    Fact,
    RequirementsSheet,
    RuleFindings,
    Severity,
    Stream,
    Target,
)

MAX_QUESTIONS = 6                    # questions that go to the report, in ranked order
ASK_LIMIT = 3                        # questions shown to the scientist at once
MAX_FREE_TEXT = 80                   # longest free-text answer (the name of a variable)
SHORTLIST = 3                        # best open candidates per stream that count as "the shortlist"
EFFECT_PARTS = 2                     # differences named next to an option, most significant first
IMPACT_WEIGHT = {"STATUS_CHANGE": 1.0, "PRIMARY_METHOD_CHANGE": 0.6, "TECHNIQUE_CHANGE": 0.3, "RISK_ONLY": 0.1}
PLAN_WEIGHT = 0.05                   # an answer that only sharpens the feasibility plan
DECLARED_CONFIDENCE = 0.5            # impact the engine declares but a what-if cannot show (ambiguous terms)
NO_CHANGE = "no change to the recommendation"
DEFINED, UNDEFINED = "defined", "undefined"
DEFINED_TARGET = "the defined target variable"
UNDEFINED_TARGET = "a variable that is not defined yet"
IMPACT_CHANGES = {
    "STATUS_CHANGE": "Whether a method can be chosen at all (the decision status)",
    "PRIMARY_METHOD_CHANGE": "Which method is recommended first",
    "TECHNIQUE_CHANGE": "Which probe geometry or interface is used",
    "RISK_ONLY": "The acceptance criteria and the feasibility plan"}
_STATUS_WORDS = {DecisionStatus.PROVISIONAL: "provisional assessment",
                 DecisionStatus.INSUFFICIENT_INFORMATION: "insufficient information",
                 DecisionStatus.OUTSIDE_SUPPORTED_SCOPE: "outside the supported scope"}
_RISK_SEVERITIES = (Severity.warning, Severity.premise, Severity.blocking)

ENUM_SLOTS = {"distance": DISTANCE, "use_context": USE_CONTEXT, "requested_certainty": CERTAINTY,
              "domain": DOMAINS}
_TARGETS = re.compile(r"^streams\.([^.]+)\.targets$")
_STREAM_FACT = re.compile(r"^streams\.([^.]+)\.(matrix|optics)$")
_STREAM_SLOT = re.compile(r"^streams\.([^.]+)\.([a-z_]+)$")


# ---------------------------------------------------------------- confirmed facts

def apply_confirmed(sheet: RequirementsSheet, confirmed: dict[str, str]) -> RequirementsSheet:
    """A copy of the sheet with facts confirmed in conversation applied. They carry the provenance
    `CONFIRMED_QUOTE`, never a client quote. The value `unknown` ('not known yet') changes nothing.
    A target slot takes the name of the variable, or `defined` / `undefined` when the scientist says only that."""
    out = sheet.model_copy(deep=True)
    for slot, value in confirmed.items():
        value = str(value).strip()
        if not value or value == "unknown":
            continue
        fact = Fact(value=value, quote=CONFIRMED_QUOTE)
        if m := _STREAM_FACT.match(slot):
            stream = next((s for s in out.streams if s.id == m.group(1)), None)
            allowed = MATRIX if m.group(2) == "matrix" else OPTICS
            if stream is None or value not in allowed:
                raise ValueError(f"cannot confirm {slot} = {value!r}")
            setattr(stream, m.group(2), fact)
        elif m := _TARGETS.match(slot):
            stream = next((s for s in out.streams if s.id == m.group(1)), None)
            if stream is None:
                raise ValueError(f"unknown stream in {slot!r}")
            defined = [t for t in stream.targets if t.defined]
            if value == DEFINED:
                stream.targets = defined or [Target(name=DEFINED_TARGET, defined=True, quote=CONFIRMED_QUOTE)]
            elif value == UNDEFINED:
                if not stream.targets or defined == stream.targets:
                    stream.targets = [Target(name=UNDEFINED_TARGET, defined=False, quote=CONFIRMED_QUOTE)]
            else:
                stream.targets = [*defined, Target(name=value, defined=True, quote=CONFIRMED_QUOTE)]
        elif slot in RequirementsSheet.GLOBAL_FACTS or slot == "domain":
            if slot in ENUM_SLOTS and value not in ENUM_SLOTS[slot]:
                raise ValueError(f"{slot} must be one of {ENUM_SLOTS[slot]}, got {value!r}")
            if slot == "domain":
                out.domain = value
            else:
                setattr(out, slot, fact)
        elif slot.startswith("term:"):
            term = slot[5:].lower()
            hit = [i for i in out.interpretations if i.term.lower() == term]
            if not hit:
                raise ValueError(f"unknown term in {slot!r}")
            for i in hit:
                i.canonical, i.ambiguous, i.how = value, False, "context"
        else:
            raise ValueError(f"cannot confirm unknown slot {slot!r}")
    return out


# ---------------------------------------------------------------- the slot ontology

@dataclass(frozen=True)
class Option:
    value: str
    label: str
    prior: float = 1.0                # relative weight; an option without one counts as 1
    note: str = ""                    # the plan effect, shown when the engine sees no change


@dataclass(frozen=True)
class Spec:
    slot: str                         # "distance", "streams.*.optics" or "term:*"
    text: str
    why: str
    options: tuple[Option, ...] = ()
    accepts: tuple[str, ...] = ()
    when: tuple[str, ...] = ()
    free_text: bool = False
    plan: bool = False
    reads: tuple[str, ...] = ()
    replaces: tuple[str, ...] = ()

    @property
    def per_stream(self) -> bool:
        return self.slot.startswith("streams.*.")

    @property
    def name(self) -> str:
        return self.slot.rsplit(".", 1)[-1]

    @property
    def allowed(self) -> tuple[str, ...]:
        return tuple(dict.fromkeys([*(o.value for o in self.options), *self.accepts]))


@dataclass(frozen=True)
class Ontology:
    specs: tuple[Spec, ...] = ()
    risks: dict[str, str] = field(default_factory=dict)
    methods: dict[str, str] = field(default_factory=dict)

    def spec(self, slot: str) -> Spec | None:
        """The ontology entry that answers `slot` (a concrete path such as `streams.s2.optics`), if any."""
        key = "term:*" if slot.startswith("term:") else (
            f"streams.*.{m.group(2)}" if (m := _STREAM_SLOT.match(slot)) else slot)
        return next((s for s in self.specs if s.slot == key), None)

    def covers(self, slot: str) -> bool:
        """Whether the gate asks about `slot`, or replaces the rule question stored under that id."""
        return self.spec(slot) is not None or any(slot in s.replaces for s in self.specs)

    def open_slots(self, sheet: RequirementsSheet) -> Iterator[tuple[Spec, str, Stream | None]]:
        """(entry, concrete slot, stream) for every unknown slot, in ontology order."""
        for spec in self.specs:
            if spec.slot == "term:*":
                for it in sheet.interpretations:
                    if it.ambiguous and len(self._readings(it.alternatives)) >= 2:
                        yield spec, f"term:{it.term}", None
            elif spec.per_stream:
                for s in sheet.streams:
                    if _is_open(spec, sheet, s) and (not spec.when or s.matrix.value in spec.when):
                        yield spec, f"streams.{s.id}.{spec.name}", s
            elif _is_open(spec, sheet, None):
                yield spec, spec.slot, None

    def options(self, sheet: RequirementsSheet, slot: str) -> list[Option]:
        """The offered options of a concrete slot; an ambiguous term offers its alternatives."""
        spec = self.spec(slot)
        if spec is None:
            return []
        if spec.slot == "term:*":
            term = slot[5:].lower()
            alts = next((i.alternatives for i in sheet.interpretations if i.term.lower() == term), [])
            return [Option(a, self.methods[a]) for a in self._readings(alts)]
        return list(spec.options)

    def _readings(self, alternatives: list[str]) -> list[str]:
        """The readings of an ambiguous term worth a button: methods the ontology names (an extraction can invent
        others, which must never become an option)."""
        return [a for a in dict.fromkeys(alternatives) if a in self.methods]

    def check(self, sheet: RequirementsSheet, slot: str, value: str) -> str:
        """The value to store for an answer, or ValueError when the slot or the value is not in the ontology.
        'unknown' ('not known yet') is always allowed for a known slot."""
        spec = self.spec(slot)
        if spec is None:
            raise ValueError(f"cannot answer unknown slot {slot!r}")
        if m := _STREAM_SLOT.match(slot):
            if not any(s.id == m.group(1) for s in sheet.streams):
                raise ValueError(f"unknown stream in {slot!r}")
        elif spec.slot == "term:*" and not self.options(sheet, slot):
            raise ValueError(f"unknown term in {slot!r}")
        value = str(value).strip()
        if value in ("", "unknown"):
            return "unknown"
        allowed = [o.value for o in self.options(sheet, slot)] if spec.slot == "term:*" else list(spec.allowed)
        if hit := next((a for a in allowed if a.casefold() == value.casefold()), None):
            return hit
        if spec.free_text and len(value) <= MAX_FREE_TEXT and "\n" not in value:
            return value
        raise ValueError(f"{slot} must be one of {allowed}, got {value!r}")


def _is_open(spec: Spec, sheet: RequirementsSheet, stream: Stream | None) -> bool:
    name = spec.name
    if stream is not None:
        if name == "targets":
            return not stream.targets or any(not t.defined for t in stream.targets)
        return not getattr(stream, name).stated
    if name == "domain":
        return sheet.domain == "other"
    return not getattr(sheet, name).stated


def _load(path: Path) -> Ontology:
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    specs = []
    for s in raw.get("slots", []):
        options = tuple(Option(str(o["value"]), str(o["label"]), float(o.get("prior", 1.0)), str(o.get("note", "")))
                        for o in s.get("values", []))
        specs.append(Spec(slot=s["slot"], text=s["text"], why=s["why"], options=options,
                          accepts=tuple(str(a) for a in s.get("accepts", [])), when=tuple(s.get("when", [])),
                          free_text=bool(s.get("free_text")), plan=bool(s.get("plan")),
                          reads=tuple(s.get("reads", [])), replaces=tuple(s.get("replaces", []))))
    return Ontology(tuple(specs), dict(raw.get("risks", {})), dict(raw.get("methods", {})))


@lru_cache(maxsize=4)
def _cached(path: str, mtime_ns: int) -> Ontology:
    return _load(Path(path))


def load_ontology(root: Path) -> Ontology:
    """The slot ontology of a knowledge-base folder; empty (the gate asks nothing) when the file is missing."""
    path = Path(root) / "ontology.yaml"
    return _cached(str(path), path.stat().st_mtime_ns) if path.exists() else Ontology()


# ---------------------------------------------------------------- outcome signature

@dataclass(frozen=True)
class Outcome:
    """What the engine decided, boiled down to what a scientist would notice."""
    status: DecisionStatus
    leads: tuple[tuple[str, str, str], ...]               # per stream: (stream id, method, technique id) of the best
    shortlist: frozenset[tuple[str, str]]                 # (stream id, technique id) of the best open candidates
    blocked: frozenset[tuple[str, str]]                   # (stream id, technique id) of blocked candidates
    risks: frozenset[tuple[str, str]]                     # (rule id, stream id) of warnings and stronger findings
    premises: tuple[tuple[int, str], ...]                 # (premise index, strictest verdict)
    labels: dict[str, str] = field(default_factory=dict, compare=False, hash=False)    # technique id -> "NIR ..."


def outcome(sheet: RequirementsSheet, findings: RuleFindings) -> Outcome:
    leads, short, blocked, labels = [], set(), set(), {}
    for c in findings.candidates:
        labels.setdefault(c.technique_id, _label(c.method, c.technique))
        if c.blocked:
            blocked.add((c.stream_id, c.technique_id))
    for s in sheet.streams:
        open_ = [c for c in findings.candidates if c.stream_id == s.id and not c.blocked]
        if open_:                                          # the engine lists candidates best first
            leads.append((s.id, open_[0].method, open_[0].technique_id))
        short |= {(s.id, c.technique_id) for c in open_[:SHORTLIST]}
    verdicts: dict[int, str] = {}
    strictness = {"SUPPORTED": 0, "UNVERIFIABLE": 1, "CONTRADICTED": 2}
    for f in findings.findings:
        if f.premise_index is not None and f.premise_verdict is not None:
            v = f.premise_verdict.value
            if strictness[v] >= strictness.get(verdicts.get(f.premise_index, "SUPPORTED"), 0):
                verdicts[f.premise_index] = v
    risks = {(f.rule_id, f.stream_id or "") for f in findings.findings if f.severity in _RISK_SEVERITIES}
    return Outcome(findings.status, tuple(leads), frozenset(short), frozenset(blocked), frozenset(risks),
                   tuple(sorted(verdicts.items())), labels)


def _label(method: str, technique: str) -> str:
    """'NIR diffuse reflection probe'; a technique that already names its method ('Raman probe') stays as it is."""
    return technique if technique.casefold().startswith(method.casefold()) else f"{method} {technique}"


def change(base: Outcome, after: Outcome) -> str | None:
    """The most significant way `after` differs from `base`, or None."""
    if after.status != base.status:
        return "STATUS_CHANGE"
    if {(sid, m) for sid, m, _ in after.leads} != {(sid, m) for sid, m, _ in base.leads}:
        return "PRIMARY_METHOD_CHANGE"
    if after.leads != base.leads or after.shortlist != base.shortlist or after.blocked != base.blocked:
        return "TECHNIQUE_CHANGE"
    if after.risks != base.risks or after.premises != base.premises:
        return "RISK_ONLY"
    return None


def effects(base: Outcome, after: Outcome, sheet: RequirementsSheet, ontology: Ontology) -> list[str]:
    """The differences between two outcomes in a scientist's words, most significant first
    ('primary method → Raman', 'status → insufficient information', 'adds risk: a long fiber link')."""
    out = []
    names = {s.id: s.name for s in sheet.streams} if len(sheet.streams) > 1 else {}
    label = {**base.labels, **after.labels}

    def where(sid: str) -> str:
        return f" ({names[sid]})" if sid in names else ""

    if after.status != base.status:
        out.append(f"status → {_STATUS_WORDS[after.status]}")
    was = {sid: (m, t) for sid, m, t in base.leads}
    now = {sid: (m, t) for sid, m, t in after.leads}
    for s in sheet.streams:
        if s.id in was and s.id not in now:
            out.append(f"no open candidate left{where(s.id)}")
        elif s.id in now and s.id not in was or s.id in now and now[s.id][0] != was[s.id][0]:
            out.append(f"primary method → {now[s.id][0]}{where(s.id)}")
        elif s.id in now and now[s.id][1] != was[s.id][1]:
            out.append(f"primary technique → {label[now[s.id][1]]}{where(s.id)}")
    for verb, tids in (("blocks", after.blocked - base.blocked), ("unblocks", base.blocked - after.blocked)):
        if tids:
            out.append(f"{verb} {_join(label[t] for _, t in sorted(tids))}")
    added, dropped = after.shortlist - base.shortlist, base.shortlist - after.shortlist
    if added:
        out.append(f"adds {_join(label[t] for _, t in sorted(added))} to the shortlist")
    if dropped:
        out.append(f"drops {_join(label[t] for _, t in sorted(dropped))} from the shortlist")
    risk = lambda rule: ontology.risks.get(rule, rule)
    for verb, rules in (("adds", after.risks - base.risks), ("removes", base.risks - after.risks)):
        if rules:
            out.append(f"{verb} risk: {_join(dict.fromkeys(risk(r) for r, _ in sorted(rules)))}")
    was_p, now_p = dict(base.premises), dict(after.premises)
    for i, verdict in sorted(now_p.items()):
        if was_p.get(i) != verdict and i < len(sheet.premises):
            out.append(f"premise “{_short(sheet.premises[i].text)}” → {verdict.lower()}")
    return out


def _join(items: Iterable[str]) -> str:
    items = list(dict.fromkeys(items))
    return ", ".join(items) if len(items) <= 2 else f"{items[0]} and {len(items) - 1} more"


def _short(text: str, n: int = 40) -> str:
    text = " ".join(text.split())
    return text if len(text) <= n else text[:n - 1].rstrip() + "…"


# ---------------------------------------------------------------- value of information

def _weights(options: list[Option]) -> list[float]:
    total = sum(o.prior for o in options) or 1.0
    return [o.prior / total for o in options]


def rank_questions(sheet: RequirementsSheet, findings: RuleFindings, kb: KnowledgeBase,
                   what_if: Callable[[RequirementsSheet], RuleFindings],
                   ontology: Ontology | None = None) -> list[ClarifyQuestion]:
    """Every open slot with an answer that matters, best first. `findings` is the engine's result for `sheet`;
    `what_if` evaluates a hypothetical sheet and must apply what the real engine applies (application candidates)."""
    onto = ontology if ontology is not None else load_ontology(kb.root)
    base = outcome(sheet, findings)
    names = {s.id: s.name for s in sheet.streams} if len(sheet.streams) > 1 else {}
    ranked: list[tuple[float, int, int, ClarifyQuestion]] = []
    for order, (spec, slot, stream) in enumerate(onto.open_slots(sheet)):
        options = onto.options(sheet, slot)
        if not 2 <= len(options) <= 5:
            continue
        shown, classes, score = [], [], 0.0
        for opt, prior in zip(options, _weights(options), strict=True):
            if spec.slot == "term:*":                 # the engine cannot show it; the rule declares its weight
                kind, parts = "PRIMARY_METHOD_CHANGE", [f"reads “{slot[5:]}” as {opt.value}"]
                weight = IMPACT_WEIGHT[kind] * DECLARED_CONFIDENCE
            else:
                hypo = apply_confirmed(sheet, {slot: opt.value})
                after = outcome(hypo, what_if(hypo))
                kind, parts = change(base, after), effects(base, after, sheet, onto)
                weight = IMPACT_WEIGHT[kind] if kind else (PLAN_WEIGHT if spec.plan else 0.0)
            if opt.note:
                parts.append(f"plan: {opt.note}")
            classes.append(kind)
            score += prior * weight
            shown.append(ClarifyOption(value=opt.value, label=opt.label, effect="; ".join(parts[:EFFECT_PARTS]) or NO_CHANGE))
        impact = next((c for c in IMPACT_ORDER if c in classes), "RISK_ONLY" if score > 0 else None)
        if impact is None:
            continue
        text = spec.text.replace("{term}", slot[5:]) if spec.slot == "term:*" else spec.text
        if stream is not None and stream.id in names:
            text = text.rstrip("?.") + f" (stream {names[stream.id]})?"
        question = ClarifyQuestion(id=slot, slot=slot, stream_id=stream.id if stream is not None else None,
                                   text=text, why=spec.why, impact=impact, options=shown)
        ranked.append((-score, IMPACT_ORDER.index(impact), order, question))
    return [q for *_, q in sorted(ranked, key=lambda r: r[:3])]


def to_ask(questions: Iterable[ClarifyQuestion], deferred: Iterable[str] = (),
           limit: int = ASK_LIMIT) -> list[ClarifyQuestion]:
    """The questions worth putting to the scientist now: the top ones that can change the recommendation, minus
    those answered 'not known yet'. Questions that only sharpen the plan stay in the report."""
    skip = set(deferred)
    return [q for q in questions if q.slot not in skip and q.impact != "RISK_ONLY"][:limit]


def decision_text(q: ClarifyQuestion) -> str:
    """The report's 'decision it changes' for a question: the impact class and what its options would do."""
    parts = [f"{o.label}: {o.effect}" for o in q.options if o.effect != NO_CHANGE][:3]
    return IMPACT_CHANGES[q.impact] + (f" ({'; '.join(parts)})" if parts else "")


# ---------------------------------------------------------------- "Other..." free text

class MappedAnswer(BaseModel):
    value: str = Field("unknown", description="the allowed value that matches the answer, or 'unknown'")


def map_text(gateway, ontology: Ontology, sheet: RequirementsSheet, slot: str, text: str) -> str:
    """The value a scientist's own words stand for: an allowed value of the slot, the variable's name for a
    free-text slot, or 'unknown'. An exact label or value needs no model; anything else is one small structured
    call to the classifier role, and its answer is accepted only if code can verify it."""
    spec = ontology.spec(slot)
    if spec is None:
        raise ValueError(f"cannot answer unknown slot {slot!r}")
    text = " ".join(str(text).split())
    if not text:
        raise ValueError("no answer text")
    options = ontology.options(sheet, slot)
    allowed = [o.value for o in options] + list(spec.accepts)
    for opt in options:
        if text.casefold() in (opt.value.casefold(), opt.label.casefold()):
            return opt.value
    if text.casefold() in (a.casefold() for a in allowed):
        return next(a for a in allowed if a.casefold() == text.casefold())
    prompt, _ = render("answer_map.j2", question=spec.text.replace("{term}", slot[5:]), free_text=spec.free_text,
                       options=[(o.value, o.label) for o in options], accepts=list(spec.accepts), text=text)
    value = " ".join(gateway.complete("classifier", [{"role": "user", "content": prompt}], schema=MappedAnswer,
                                      reasoning="off").parsed.value.split())
    if hit := next((a for a in allowed if a.casefold() == value.casefold()), None):
        return hit
    if spec.free_text and value.casefold() != "unknown" and len(value) <= MAX_FREE_TEXT \
            and value.casefold() in text.casefold():
        return value                                      # the scientist's own words, never a paraphrase
    return "unknown"
