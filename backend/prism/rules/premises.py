"""Premise rules: claims or requests in the enquiry that the sources support, contradict or leave open."""
from __future__ import annotations

from prism.rules.base import RuleContext, rule
from prism.schemas import DecisionStatus, Finding, PremiseVerdict, Severity

_FLUOR_WORDS = ("fluorescent marker", "fluorescent indicator", "fluorescent probe", "fluorescent dye",
                "fluorophore", "autofluorescence")


@rule("R-CAL-SCOPE")
def cal_scope(ctx: RuleContext) -> list[Finding]:
    return [Finding(
        rule_id="R-CAL-SCOPE", severity=Severity.premise, premise_index=i,
        premise_verdict=PremiseVerdict.UNVERIFIABLE, slots_read=["premises"],
        evidence_ids=["S01-p10-nir-chemometrics", "S01-p09-variable-quality"],
        message="A chemometric calibration is built from data on a specific material. Whether it stays valid "
                "for a changed formulation or matrix is unverified until it is tested against independent "
                "reference results on the new material. Adding another method does not by itself keep an "
                "existing calibration valid.",
        question="Which components, concentration ranges and physical properties differ between the calibrated "
                 "material and the new one, and which reference results exist for the new material?",
        question_impact="PRIMARY_METHOD_CHANGE")
        for i, p in enumerate(ctx.sheet.premises) if p.type == "transfer_calibration"]


@rule("R-FLUOROPHORE")
def fluorophore(ctx: RuleContext) -> list[Finding]:
    known = [k.lower() for k in ctx.kb.methods["Fluorescence"].get("known_fluorophores", [])]
    intended = "Fluorescence" in ctx.methods_intended()
    premise_index = next((i for i, p in enumerate(ctx.sheet.premises) if p.method == "Fluorescence"), None)
    context = " ".join(p.text for p in ctx.sheet.premises).lower()
    out = []
    for s in ctx.sheet.streams:
        names = " ".join(t.name for t in s.targets).lower()
        if any(k in names for k in known) or any(w in names or w in context for w in _FLUOR_WORDS):
            continue
        out.append(Finding(
            rule_id="R-FLUOROPHORE", severity=Severity.premise if intended else Severity.info, stream_id=s.id,
            blocks=[f"{s.id}:Fluorescence:*"], slots_read=["streams.targets", "premises"],
            evidence_ids=["S01-p05-fluorescence-not-general", "S01-p16-fluorescence-targets",
                          "TABLE-fluorescence_fluorimetric_probe"],
            message="Fluorescence reports only a defined fluorescent species or a justified indicator. No "
                    "fluorescent target or indicator is identified here, so fluorescence cannot be assumed to "
                    "measure the requested variables directly; high sensitivity alone does not give selectivity.",
            premise_index=premise_index if intended else None,
            premise_verdict=PremiseVerdict.UNVERIFIABLE if intended and premise_index is not None else None,
            question=("Is there a known fluorescent compound, marker or reference relationship linked to the "
                      "variables you want to report?") if intended else None,
            question_impact="PRIMARY_METHOD_CHANGE" if intended else None))
    return out


@rule("R-EVIDENCE-SCOPE")
def evidence_scope(ctx: RuleContext) -> list[Finding]:
    readiness = (ctx.sheet.requested_certainty.value in ("approve", "exact_config")
                 or ctx.sheet.use_context.value in ("production", "clinical"))
    weak = [c.id for c in ctx.kb.cards.values()
            if c.scope.value in ("in_vitro_poc", "lab_study") and c.source in ("S03", "S04")]
    return [Finding(
        rule_id="R-EVIDENCE-SCOPE", severity=Severity.premise, premise_index=i, evidence_ids=weak[:4],
        premise_verdict=PremiseVerdict.CONTRADICTED if readiness else PremiseVerdict.UNVERIFIABLE,
        slots_read=["premises", "use_context", "requested_certainty"],
        message="The studies in the supplied materials are laboratory or in-vitro proofs of concept. They justify "
                "testing a method; they are not evidence that a new set-up is ready for a different use.")
        for i, p in enumerate(ctx.sheet.premises) if p.type == "quote_as_proof"]


@rule("R-UNDEFINED-TARGET")
def undefined_target(ctx: RuleContext) -> list[Finding]:
    return [Finding(
        rule_id="R-UNDEFINED-TARGET", severity=Severity.gate, status=DecisionStatus.INSUFFICIENT_INFORMATION,
        stream_id=s.id, slots_read=[f"streams.{s.id}.targets"],
        evidence_ids=["S01-p03-unknown-composition", "S02-p03-msf-screening"],
        message="The variable to be measured is not defined yet, so no method or sensor configuration can be "
                "chosen. The appropriate first step is a multi-method screening of representative good and "
                "off-specification samples.",
        question="Which substance or quality variable must be detected or quantified, and are retained good and "
                 "off-specification samples available?", question_impact="STATUS_CHANGE")
        for s in ctx.sheet.streams if not s.targets or any(not t.defined for t in s.targets)]


@rule("R-CLINICAL-SCOPE")
def clinical_scope(ctx: RuleContext) -> list[Finding]:
    if ctx.sheet.use_context.value != "clinical":
        return []
    return [Finding(
        rule_id="R-CLINICAL-SCOPE", severity=Severity.gate, status=DecisionStatus.OUTSIDE_SUPPORTED_SCOPE,
        slots_read=["use_context"],
        evidence_ids=["S03-p14-proof-of-concept", "S03-p03-ex-vivo-caveat", "S03-p14-false-negatives"],
        message="Decisions in clinical care are outside a first technical feasibility assessment. The materials "
                "contain in-vitro proof-of-concept results only; the next steps are research-grade studies.")]
