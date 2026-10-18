"""Stage 7: assemble the final report and render Markdown in the organisers' worked-example layout."""
from __future__ import annotations

import re

from rapidfuzz import fuzz

from prism.kb.loader import KnowledgeBase
from prism.schemas import (
    CONFIRMED_QUOTE,
    METHODS,
    AssessmentReport,
    ClaimType,
    Enquiry,
    Recommendation,
    RecRole,
    ReportBody,
    RequirementsSheet,
    RuleFindings,
    Segment,
    SourceRef,
    SpectralRange,
    StatedFact,
    Unknown,
    iter_segments,
)

_STATUS = {"PROVISIONAL": "Provisional feasibility assessment", "INSUFFICIENT_INFORMATION": "Insufficient information",
           "OUTSIDE_SUPPORTED_SCOPE": "Outside the supported scope"}
_TAG = {ClaimType.CLIENT: " _(client)_", ClaimType.ASSUMPTION: " _(assumption)_", ClaimType.UNKNOWN: " _(unknown)_",
        ClaimType.EXTERNAL: " _(external)_"}


def evidence_strength(rec: Recommendation, findings: RuleFindings) -> str:
    cands = [c for c in findings.candidates if c.method in rec.methods and c.stream_id in rec.applies_to]
    # The strength belongs to the technique the recommendation names, not to a better geometry of the same method.
    cands = [c for c in cands if c.technique == rec.technique] or cands
    if not cands:
        return "Weak"
    open_ = [c for c in cands if not c.blocked]
    if not open_:
        return "Blocked"
    best = max(open_, key=lambda c: c.score)
    critical = sum(1 for q in findings.question_seeds if q.impact in ("STATUS_CHANGE", "PRIMARY_METHOD_CHANGE"))
    value = best.fit + 2 * best.evidence - 0.5 * critical
    if best.optics <= 0:       # the engine scores this geometry 0 for the stated optics: never better than Weak
        return "Weak"
    return "Strong" if value >= 5.5 else "Moderate" if value >= 3.5 else "Weak"


_IMPACT = {"STATUS_CHANGE": "Decides whether a method can be chosen at all.",
           "PRIMARY_METHOD_CHANGE": "Can change the recommended method.",
           "TECHNIQUE_CHANGE": "Can change the probe geometry or interface.",
           "RISK_ONLY": "Needed for the feasibility plan and acceptance criteria."}
_RANGE_CAVEAT = "Nominal method range; the usable range depends on the instrument, fiber and probe."


def _provenance(quote: str | None) -> str:
    return "confirmed" if quote == CONFIRMED_QUOTE else "client"


def stated_facts(sheet: RequirementsSheet) -> list[StatedFact]:
    """Every slot the client stated, with the client's own words (never written by the LLM). A fact the scientist
    confirmed in conversation carries provenance "confirmed" and is never presented as a client quote."""
    out = []
    for s in sheet.streams:
        out += [StatedFact(slot=f"streams.{s.id}.targets", value=t.name, quote=t.quote, stream_id=s.id,
                           provenance=_provenance(t.quote)) for t in s.targets if t.quote]
        for name in ("matrix", "optics"):
            fact = getattr(s, name)
            if fact.stated:
                out.append(StatedFact(slot=f"streams.{s.id}.{name}", value=fact.value, quote=fact.quote,
                                      stream_id=s.id, provenance=_provenance(fact.quote)))
    for name in sheet.GLOBAL_FACTS:
        fact = getattr(sheet, name)
        if fact.stated:
            out.append(StatedFact(slot=name, value=fact.value, quote=fact.quote, provenance=_provenance(fact.quote)))
    return out


def key_unknowns(sheet: RequirementsSheet, findings: RuleFindings) -> list[Unknown]:
    seeds = {q.slot: q for q in findings.question_seeds}
    out = []
    for slot in sheet.unknown_slots():
        q = seeds.get(slot)
        if q is None:
            why = "Not stated by the client."
        else:
            why = f"{_IMPACT[q.impact]} {q.text_hint.strip()}".strip()
        stream_id = slot.split(".")[1] if slot.startswith("streams.") else None
        out.append(Unknown(slot=slot, why_it_matters=why, stream_id=stream_id))
    return out


def _nm(um: float) -> str:
    return f"{round(um * 1000)}"


FULL_COVER, HALF_COVER = 0.9, 0.5


def fiber_coverage(method: str, kb: KnowledgeBase) -> list[tuple[str, str, float]]:
    """(fiber id, name, share of the method's nominal range it carries) for every fiber family that carries any."""
    rng = kb.method_range(method)
    width = rng.hi_um - rng.lo_um
    out = []
    for fid, f in kb.fibers.items():
        fr = kb.fiber_range(fid)
        overlap = max(0.0, min(rng.hi_um, fr.hi_um) - max(rng.lo_um, fr.lo_um))
        if width > 0 and overlap > 0:
            out.append((fid, f.get("name", fid), overlap / width))
    return out


def fibers_for(method: str, kb: KnowledgeBase) -> list[tuple[str, str]]:
    """(fiber id, name) of the fiber families to name for a method: those that carry (nearly) all of its nominal
    range; only when none does, those that carry at least half of it."""
    cover = fiber_coverage(method, kb)
    full = [(fid, name) for fid, name, share in cover if share >= FULL_COVER]
    return full or [(fid, name) for fid, name, share in cover if share >= HALF_COVER]


def fiber_gap_note(method: str, kb: KnowledgeBase) -> str:
    """Where the named fibers stop short of the method's range (empty when they cover it)."""
    named = {fid for fid, _ in fibers_for(method, kb)}
    if not named:
        return ""
    rng = kb.method_range(method)
    hi = max(kb.fiber_range(fid).hi_um for fid in named)
    lo = min(kb.fiber_range(fid).lo_um for fid in named)
    if hi >= rng.hi_um - 1e-9 and lo <= rng.lo_um + 1e-9:
        return ""
    if hi < rng.hi_um:
        return (f"These fibers carry the range up to {round(hi * 1000)} nm; above that an infrared fiber would be "
                f"needed ({round(rng.hi_um * 1000)} nm is the nominal end of the range).")
    return f"These fibers start at {round(lo * 1000)} nm; below that another fiber type would be needed."


def spectral_range_for(method: str, kb: KnowledgeBase) -> SpectralRange:
    """Nominal method range from the KB graph, with the fiber families that carry most of it."""
    m = kb.methods[method]
    rng = kb.method_range(method)
    if method == "MIR":
        nominal = f"{round(10000 / rng.lo_um)}–{round(10000 / rng.hi_um)} cm⁻¹ ({rng.lo_um:g}–{rng.hi_um:g} µm)"
        units = "cm⁻¹"
    elif method == "Raman":
        nominal = f"Raman shift in cm⁻¹; detection region {_nm(rng.lo_um)}–{_nm(rng.hi_um)} nm"
        units = "cm⁻¹ (shift); nm (detection)"
    elif method == "Fluorescence":
        # The fluorimetry card states the UV and visible regions but no numbers; stay with its words.
        nominal, units = "UV and visible regions (excitation and emission)", "nm"
    else:
        nominal, units = f"{_nm(rng.lo_um)}–{_nm(rng.hi_um)} nm", "nm"
    fibers = [name for _, name in fibers_for(method, kb)]
    return SpectralRange(method=method, nominal_range=nominal, units=units, excitation_nm=None,
                         fiber_family_needed=", ".join(fibers) or "To be confirmed with AFS",
                         caveat=[Segment(text=_RANGE_CAVEAT, claim_type=ClaimType.AFS,
                                         evidence_ids=list(m.get("range_cards", [])))])


def _is_rule_premise(text: str, kb: KnowledgeBase) -> bool:
    t = text.strip()
    head = re.split(r"[\s:.,;]", t, maxsplit=1)[0]
    return t.startswith("R-") or head in kb.rules_meta or t in kb.rules_meta


_CLAIM_LABEL = re.compile(r"^\s*(?:" + "|".join(c.value for c in ClaimType) + r")\s*:\s*", re.IGNORECASE)
_PREMISE_MATCH = 60


def _strip_label(text: str) -> str:
    """Remove a leading claim-type label ("AFS: …"); the claim type is a separate field."""
    stripped = _CLAIM_LABEL.sub("", text, count=1)
    return stripped or text


def _is_client_premise(text: str, sheet: RequirementsSheet) -> bool:
    return any(fuzz.partial_ratio(text.lower(), p.text.lower()) >= _PREMISE_MATCH for p in sheet.premises)


def build_report(body: ReportBody, enquiry: Enquiry, sheet: RequirementsSheet, findings: RuleFindings,
                 kb: KnowledgeBase, meta: dict, compliance: dict[str, bool]) -> AssessmentReport:
    body = body.model_copy(deep=True)
    for rec in body.recommendations:
        rec.evidence_strength = evidence_strength(rec, findings)
    # Requirements come from the grounded sheet; code always overrides the LLM here.
    body.requirements.stated_facts = stated_facts(sheet)
    body.requirements.key_unknowns = key_unknowns(sheet, findings)
    body.spectral_ranges = [r for r in body.spectral_ranges if r.method in METHODS]
    have = {r.method for r in body.spectral_ranges}
    for rec in body.recommendations:
        if rec.role == RecRole.NOT_RECOMMENDED:
            continue
        for m in rec.methods:
            if m not in have and m in kb.methods:
                body.spectral_ranges.append(spectral_range_for(m, kb))
                have.add(m)
    body.premise_checks = [p for p in body.premise_checks
                           if not _is_rule_premise(p.premise, kb) and _is_client_premise(p.premise, sheet)]
    for _, s in iter_segments(body):
        s.text = _strip_label(s.text)
    cited = list(dict.fromkeys(cid for _, s in iter_segments(body) for cid in s.evidence_ids))
    sources = [SourceRef(id=c.id, citation=c.citation(), quote=c.quote, scope=c.scope, url=c.url, doi=c.doi,
                       verification=c.verification, source=c.source, title=c.title, provenance=c.provenance)
               for c in kb.cards_for(cited)]
    return AssessmentReport(**body.model_dump(), case_id=enquiry.case_id, title=enquiry.title,
                            input_sha256=enquiry.sha256, run_id=meta["run_id"], created_at=meta["created_at"],
                            kb_version=kb.version, profile=meta["profile"], model_ids=meta["model_ids"],
                            prompt_hashes=meta["prompt_hashes"], client_question=sheet.client_question,
                            streams=sheet.streams, interpretations=sheet.interpretations, sources=sources,
                            compliance=compliance)


def _end(text: str) -> str:
    """Text with its own trailing punctuation removed, ready for a ". " separator."""
    return text.strip().rstrip(".;:!, ")


_METHOD_PREFIX = re.compile(r"^\s*(?:NIR|MIR|Raman|UV-Vis|Fluorescence)\b\s*[/:·,–-]?\s*", re.IGNORECASE)


def _technique(rec: Recommendation) -> str:
    """Technique without a repeated method prefix ("NIR / reflection" → "reflection")."""
    tech = rec.technique.strip()
    while (m := _METHOD_PREFIX.match(tech)) and m.end() > 0:
        tech = tech[m.end():].strip()
    return tech


def _sources(sources: list[SourceRef]) -> list[str]:
    groups: dict[str, list[SourceRef]] = {}
    for s in sources:
        groups.setdefault(s.citation, []).append(s)
    lines = []
    for citation, refs in groups.items():
        scopes = ", ".join(dict.fromkeys(r.scope.value for r in refs))
        n = len(refs)
        lines.append(f"- {citation} ({n} card{'s' if n > 1 else ''}: {', '.join(r.id for r in refs)}; {scopes})")
    return lines


def _verified_note(s: SourceRef) -> str:
    v = s.verification
    if v is None or not v.verified:
        return ""
    return f" (external; verified {v.domain_tier.replace('_', ' ')} source {v.domain}, retrieved {v.retrieved_at[:10]})"


def _text(segments: list[Segment]) -> str:
    return " ".join(s.text + "".join(f"[^{c}]" for c in s.evidence_ids) + _TAG.get(s.claim_type, "")
                    for s in segments)


def to_markdown(r: AssessmentReport) -> str:
    verdict = r.direct_answer.verdict.value.replace("_", " ").title()
    lines = [f"# {r.case_id} · {r.title}".rstrip(" ·"), "",
             f"_Run {r.run_id} · KB {r.kb_version} · profile {r.profile}_", "",
             "## Decision status", _STATUS[r.decision_status.value], "",
             "## Direct answer", f"**{verdict}.** {_text(r.direct_answer.text)}", ""]
    lines += ["## Premise checks"] + ([f"- **{p.verdict.value}**: {_end(p.premise)}. {_text(p.explanation)}"
                                      for p in r.premise_checks] or ["- No premises to check."]) + [""]
    lines += ["## Requirements stated"] + ([
        f"- {f.slot}: {f.value} (" + ("confirmed in conversation" if f.provenance == "confirmed"
                                      else f"“{f.quote}”") + ")" for f in r.requirements.stated_facts]
        or ["- See the enquiry."]) + [""]
    lines += ["## Key unknowns"] + [f"- {u.slot}: {u.why_it_matters}" for u in r.requirements.key_unknowns] + [""]
    if r.interpretations:
        lines += ["_Interpretations:_ " + "; ".join(
            f"“{i.term}” → {i.canonical or ' or '.join(i.alternatives)} ({i.how})" for i in r.interpretations), ""]
    lines += ["## Clarification questions"] + [f"{q.priority}. {q.question} _(decides: {q.decision_it_changes})_"
                                               for q in r.clarification_questions] + [""]
    lines += ["## Recommendation"]
    for rec in r.recommendations:
        tech = _technique(rec)
        head = " + ".join(rec.methods) + (f" · {tech}" if tech else "")
        lines.append(f"- **{head}** — {rec.role.value}, evidence {rec.evidence_strength}. {_text(rec.rationale)}")
        if rec.conditions:
            lines.append(f"  - Conditions: {_text(rec.conditions)}")
        if rec.limitations:
            lines.append(f"  - Limitations: {_text(rec.limitations)}")
    lines += ["", "## Measurement concept"] + [f"- {m.stream_id}: {m.probe_geometry}; {m.location}; fiber link: "
                                                f"{_end(m.fiber_link)}. {_text(m.notes)}" for m in r.measurement_concept]
    lines += [""]
    lines += ["## Spectral range"] + [f"- {s.method}: {s.nominal_range}"
                                      + (f" (excitation {s.excitation_nm:g} nm)" if s.excitation_nm else "")
                                      + f"; fiber: {_end(s.fiber_family_needed)}. {_text(s.caveat)}"
                                      for s in r.spectral_ranges] + [""]
    lines += ["## Risks and uncertainty"] + [f"- {_text(k.risk)} Effect: {_end(k.effect)}. "
                                             f"Mitigation: {_end(k.mitigation)}." for k in r.risks]
    lines += [f"- Assumption: {a.assumption} (confirm with {a.to_confirm_with})" for a in r.assumptions] + [""]
    p = r.feasibility_plan
    lines += ["## First feasibility experiment", f"**Objective:** {p.objective}", ""]
    lines += [f"{i}. {s}" for i, s in enumerate(p.steps, start=1)] + [""]
    for label, segs in (("Samples", p.samples_and_states), ("References", p.reference_measurements),
                        ("Set-up", p.setup), ("Comparison", p.comparison), ("Validation", p.validation),
                        ("Go / no-go", p.go_no_go), ("Not demonstrated", p.not_demonstrated)):
        lines.append(f"- **{label}:** {_text(segs)}")
    lines += ["", "## Decision basis", _text(r.decision_basis), "", "## Sources"]
    lines += _sources(r.sources) + [""]
    lines += [f'[^{s.id}]: {s.citation} — "{s.quote}"' + _verified_note(s) for s in r.sources]
    return "\n".join(lines).rstrip() + "\n"
