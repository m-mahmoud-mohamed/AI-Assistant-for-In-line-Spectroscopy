"""Builders for test data. Values are generic and never taken from the H01–H06 enquiries."""
from prism.schemas import (
    Asset, ClaimType, DecisionStatus, DirectAnswer, Fact, FeasibilityPlan, MeasurementConcept, Premise,
    Question, Recommendation, RecRole, ReportBody, Requirements, RequirementsSheet, Risk, Segment,
    SpectralRange, Stream, Target, Verdict,
)


def seg(text: str = "Text.", ct: ClaimType = ClaimType.PROPOSAL, ids: list[str] | None = None) -> Segment:
    return Segment(text=text, claim_type=ct, evidence_ids=ids or [])


def minimal_body(**overrides) -> ReportBody:
    body = dict(
        decision_status=DecisionStatus.PROVISIONAL,
        direct_answer=DirectAnswer(verdict=Verdict.NOT_APPLICABLE, text=[seg("Start with a comparison study.")]),
        premise_checks=[],
        requirements=Requirements(),
        clarification_questions=[
            Question(question=f"Question {i}?", priority=i, decision_it_changes="probe geometry",
                     why_it_matters="It decides the interface.") for i in (1, 2, 3)],
        recommendations=[Recommendation(
            methods=["NIR"], technique="diffuse reflection probe", applies_to=["s1"], role=RecRole.PRIMARY,
            rationale=[seg("In-line NIR reflection is used for opaque or concentrated dairy products.",
                           ClaimType.AFS, ["S01-p17-nir-reflection-opaque"])])],
        measurement_concept=[MeasurementConcept(
            stream_id="s1", probe_geometry="diffuse reflection", location="in-line, flush-mounted",
            fiber_link="VIS-NIR silica", notes=[seg("Test on laboratory samples first.")])],
        spectral_ranges=[SpectralRange(
            method="NIR", nominal_range="780–2500 nm", units="nm", fiber_family_needed="VIS-NIR silica",
            caveat=[seg("The nominal NIR range is 780–2500 nm.", ClaimType.AFS, ["S01-p10-nir-range"])])],
        risks=[Risk(risk=[seg("Physical variation can mimic composition changes.", ClaimType.ASSUMPTION)],
                    effect="biased predictions", mitigation="vary physical conditions in the design")],
        assumptions=[],
        feasibility_plan=FeasibilityPlan(
            objective="Decide whether NIR reflection follows the target variable.",
            clarify_first=["acceptance criteria"],
            samples_and_states=[seg("Representative samples across the client's range.")],
            reference_measurements=[seg("An independent laboratory reference per target variable.")],
            setup=[seg("Laboratory comparison first, then process conditions.")],
            comparison=[seg("Single-method models first.")],
            validation=[seg("Validate on held-out batches.")],
            go_no_go=[seg("Criteria agreed with the client.")],
            not_demonstrated=[seg("Long-term process robustness.")],
            steps=["Clarify", "Collect samples", "Measure", "Model", "Validate"]),
        decision_basis=[seg("Error and bias on independent runs against client-agreed criteria.")],
    )
    body.update(overrides)
    return ReportBody(**body)


def _fact(value: str) -> Fact:
    return Fact() if value == "unknown" else Fact(value=value, quote=value)


def make_sheet(matrix: str = "liquid", optics: str = "unknown", targets: tuple[str, ...] = ("water content",),
               domain: str = "other", distance: str = "unknown", use_context: str = "unknown",
               certainty: str = "compare", premises: tuple[Premise, ...] = (), assets: tuple[Asset, ...] = (),
               undefined_targets: bool = False, process_conditions: str = "unknown",
               streams: list[Stream] | None = None) -> RequirementsSheet:
    if streams is None:
        streams = [Stream(id="s1", name="main",
                          targets=[Target(name=t, defined=not undefined_targets, quote=t) for t in targets],
                          matrix=_fact(matrix), optics=_fact(optics))]
    return RequirementsSheet(
        client_question=["What should we test first?"], streams=streams, distance=_fact(distance),
        use_context=_fact(use_context), requested_certainty=_fact(certainty),
        process_conditions=_fact(process_conditions), premises=list(premises), existing_assets=list(assets),
        domain=domain)
