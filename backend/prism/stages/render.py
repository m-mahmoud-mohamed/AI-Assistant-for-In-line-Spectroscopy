"""Stage 7: assemble the final report and render Markdown in the organisers' worked-example layout."""
from __future__ import annotations

from prism.kb.loader import KnowledgeBase
from prism.schemas import (
    AssessmentReport,
    ClaimType,
    Enquiry,
    Recommendation,
    ReportBody,
    RequirementsSheet,
    RuleFindings,
    Segment,
    SourceRef,
    iter_segments,
)

_STATUS = {"PROVISIONAL": "Provisional feasibility assessment", "INSUFFICIENT_INFORMATION": "Insufficient information",
           "OUTSIDE_SUPPORTED_SCOPE": "Outside the supported scope"}
_TAG = {ClaimType.CLIENT: " _(client)_", ClaimType.ASSUMPTION: " _(assumption)_", ClaimType.UNKNOWN: " _(unknown)_",
        ClaimType.EXTERNAL: " _(external)_"}


def evidence_strength(rec: Recommendation, findings: RuleFindings) -> str:
    cands = [c for c in findings.candidates if c.method in rec.methods and c.stream_id in rec.applies_to]
    if not cands:
        return "Weak"
    open_ = [c for c in cands if not c.blocked]
    if not open_:
        return "Blocked"
    best = max(open_, key=lambda c: c.score)
    critical = sum(1 for q in findings.question_seeds if q.impact in ("STATUS_CHANGE", "PRIMARY_METHOD_CHANGE"))
    value = best.fit + best.evidence - 0.5 * critical
    return "Strong" if value >= 3 else "Moderate" if value >= 1.5 else "Weak"


def build_report(body: ReportBody, enquiry: Enquiry, sheet: RequirementsSheet, findings: RuleFindings,
                 kb: KnowledgeBase, meta: dict, compliance: dict[str, bool]) -> AssessmentReport:
    body = body.model_copy(deep=True)
    for rec in body.recommendations:
        rec.evidence_strength = evidence_strength(rec, findings)
    cited = list(dict.fromkeys(cid for _, s in iter_segments(body) for cid in s.evidence_ids))
    sources = [SourceRef(id=c.id, citation=c.citation(), quote=c.quote, scope=c.scope, url=c.url)
               for c in kb.cards_for(cited)]
    return AssessmentReport(**body.model_dump(), case_id=enquiry.case_id, title=enquiry.title,
                            input_sha256=enquiry.sha256, run_id=meta["run_id"], created_at=meta["created_at"],
                            kb_version=kb.version, profile=meta["profile"], model_ids=meta["model_ids"],
                            prompt_hashes=meta["prompt_hashes"], client_question=sheet.client_question,
                            streams=sheet.streams, interpretations=sheet.interpretations, sources=sources,
                            compliance=compliance)


def _text(segments: list[Segment]) -> str:
    return " ".join(s.text + "".join(f"[^{c}]" for c in s.evidence_ids) + _TAG.get(s.claim_type, "")
                    for s in segments)


def to_markdown(r: AssessmentReport) -> str:
    verdict = r.direct_answer.verdict.value.replace("_", " ").title()
    lines = [f"# {r.case_id} · {r.title}".rstrip(" ·"), "",
             f"_Run {r.run_id} · KB {r.kb_version} · profile {r.profile}_", "",
             "## Decision status", _STATUS[r.decision_status.value], "",
             "## Direct answer", f"**{verdict}.** {_text(r.direct_answer.text)}", ""]
    lines += ["## Premise checks"] + ([f"- **{p.verdict.value}**: {p.premise}. {_text(p.explanation)}"
                                      for p in r.premise_checks] or ["- No premises to check."]) + [""]
    lines += ["## Requirements stated"] + ([f"- {f.slot}: {f.value} (“{f.quote}”)" for f in r.requirements.stated_facts]
                                           or ["- See the enquiry."]) + [""]
    lines += ["## Key unknowns"] + [f"- {u.slot}: {u.why_it_matters}" for u in r.requirements.key_unknowns] + [""]
    if r.interpretations:
        lines += ["_Interpretations:_ " + "; ".join(
            f"“{i.term}” → {i.canonical or ' or '.join(i.alternatives)} ({i.how})" for i in r.interpretations), ""]
    lines += ["## Clarification questions"] + [f"{q.priority}. {q.question} _(decides: {q.decision_it_changes})_"
                                               for q in r.clarification_questions] + [""]
    lines += ["## Recommendation"]
    for rec in r.recommendations:
        lines.append(f"- **{' + '.join(rec.methods)} · {rec.technique}** — {rec.role.value}, evidence "
                     f"{rec.evidence_strength}. {_text(rec.rationale)}")
        if rec.conditions:
            lines.append(f"  - Conditions: {_text(rec.conditions)}")
        if rec.limitations:
            lines.append(f"  - Limitations: {_text(rec.limitations)}")
    lines += ["", "## Measurement concept"] + [f"- {m.stream_id}: {m.probe_geometry}; {m.location}; fiber link: "
                                                f"{m.fiber_link}. {_text(m.notes)}" for m in r.measurement_concept]
    lines += [""]
    lines += ["## Spectral range"] + [f"- {s.method}: {s.nominal_range}"
                                      + (f" (excitation {s.excitation_nm})" if s.excitation_nm else "")
                                      + f"; fiber: {s.fiber_family_needed}. {_text(s.caveat)}"
                                      for s in r.spectral_ranges] + [""]
    lines += ["## Risks and uncertainty"] + [f"- {_text(k.risk)} Effect: {k.effect}. Mitigation: {k.mitigation}."
                                             for k in r.risks]
    lines += [f"- Assumption: {a.assumption} (confirm with {a.to_confirm_with})" for a in r.assumptions] + [""]
    p = r.feasibility_plan
    lines += ["## First feasibility experiment", f"**Objective:** {p.objective}", ""]
    lines += [f"{i}. {s}" for i, s in enumerate(p.steps, start=1)] + [""]
    for label, segs in (("Samples", p.samples_and_states), ("References", p.reference_measurements),
                        ("Set-up", p.setup), ("Comparison", p.comparison), ("Validation", p.validation),
                        ("Go / no-go", p.go_no_go), ("Not demonstrated", p.not_demonstrated)):
        lines.append(f"- **{label}:** {_text(segs)}")
    lines += ["", "## Decision basis", _text(r.decision_basis), "", "## Sources"]
    lines += [f"- {s.citation} ({s.scope.value})" for s in r.sources] + [""]
    lines += [f'[^{s.id}]: {s.citation} — "{s.quote}"' for s in r.sources]
    return "\n".join(lines).rstrip() + "\n"
