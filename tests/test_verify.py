from prism.rules.engine import evaluate
from prism.schemas import (
    ClaimType,
    DecisionStatus,
    Question,
    Recommendation,
    RecRole,
    Requirements,
    SpectralRange,
    StatedFact,
)
from prism.stages.checks import CheckContext, compliance, numbers, run_checks
from prism.stages.retrieve import Retriever
from prism.stages.verify import verify
from tests.factories import make_sheet, minimal_body, seg
from tests.fakes import FakeGateway

TEXT = "Monitor water content in a liquid stream; the analyzer is 40 m away and water is about 2 % ."


def cx(kb, body, sheet=None):
    sheet = sheet or make_sheet(matrix="liquid", optics="opaque", domain="dairy_food", targets=("water content",))
    findings = evaluate(sheet, kb)
    pack = Retriever(kb).pack(sheet, findings)
    return CheckContext(body=body, sheet=sheet, findings=findings, pack=pack, kb=kb, source_texts=[TEXT])


def ids(issues):
    return {i.check_id for i in issues if i.severity == "error"}


def test_minimal_body_passes(kb):
    assert run_checks(cx(kb, minimal_body())) == []


def test_number_guard_allows_client_numbers(kb):
    body = minimal_body(decision_basis=[seg("The 40 m link and about 2 % water must be confirmed.")])
    assert "P-NO-NUMBERS" not in ids(run_checks(cx(kb, body)))
    body = minimal_body(decision_basis=[seg("Expect an error below 0.05 %.")])
    assert "P-NO-NUMBERS" in ids(run_checks(cx(kb, body)))


def test_numbers_normalise_separators():
    assert numbers("4,000 cm-1 and 0,5 % and 780–2500 nm") == {"4000", "0.5", "780", "2500"}


def test_uncited_or_unknown_card_is_flagged(kb):
    body = minimal_body(decision_basis=[seg("Raman works.", ClaimType.AFS, ["NOT-A-CARD"])])
    assert "C-IDS" in ids(run_checks(cx(kb, body)))


def test_guarantee_and_band_pick_are_flagged(kb):
    body = minimal_body(decision_basis=[seg("This set-up guarantees success at the optimal wavelength band.")])
    assert {"P-NO-GUARANTEE", "P-NO-BAND-PICK"} <= ids(run_checks(cx(kb, body)))


def test_min_recommendation_check(kb):
    rec = Recommendation(methods=["NIR"], technique="diffuse reflection probe", role=RecRole.NOT_RECOMMENDED,
                         rationale=[seg("Not suitable.")])
    assert "P-MIN-RECOMMENDATION" in ids(run_checks(cx(kb, minimal_body(recommendations=[rec]))))


def test_loosened_status_is_an_error(kb):
    sheet = make_sheet(targets=("contaminant",), undefined_targets=True)
    assert "C-STATUS" in ids(run_checks(cx(kb, minimal_body(decision_status=DecisionStatus.PROVISIONAL), sheet)))


def test_self_answered_fact_is_flagged(kb):
    body = minimal_body(requirements=Requirements(stated_facts=[StatedFact(slot="concentration_range",
                                                                           value="0-5 %", quote="0 to 5 %")]))
    assert "P-NO-SELF-ANSWER" in ids(run_checks(cx(kb, body)))


def test_question_count_and_plan_steps(kb):
    body = minimal_body(clarification_questions=[Question(question="Q?", priority=1, decision_it_changes="x",
                                                          why_it_matters="y")])
    assert "P-QUESTIONS" in ids(run_checks(cx(kb, body)))


def paraphrased_body():
    """minimal_body with its two sourced sentences reworded (word-for-word card claims are not judged)."""
    rec = Recommendation(methods=["NIR"], technique="diffuse reflection probe", role=RecRole.PRIMARY, rationale=[
        seg("NIR reflection probes serve opaque dairy products, as the source says.", ClaimType.AFS,
            ["S01-p17-nir-reflection-opaque"])])
    rng = SpectralRange(method="NIR", nominal_range="780–2500 nm", units="nm", fiber_family_needed="VIS-NIR silica",
                        caveat=[seg("The source gives 780–2500 nm for NIR.", ClaimType.AFS, ["S01-p10-nir-range"])])
    return minimal_body(recommendations=[rec], spectral_ranges=[rng])


def test_judge_unsupported_claim_becomes_issue(kb):
    c = cx(kb, paraphrased_body())
    gw = FakeGateway({"judge": [{"verdicts": [{"id": "c1", "verdict": "unsupported", "reason": "lab only"},
                                              {"id": "c2", "verdict": "partial", "reason": "wider than the quote"}]}]})
    report = verify(c.body, c.sheet, c.findings, c.pack, kb, c.source_texts, gw, ["What should we test?"])
    assert not report.passed and compliance(report)["C-SUPPORT"] is False
    assert compliance(report)["P-QUESTIONS"] is True
    assert [v.verdict for v in report.verdicts] == ["unsupported", "partial"]
    assert [i.severity for i in report.issues if i.check_id == "C-SUPPORT"] == ["error", "warning"]
    assert [r["role"] for r in gw.requests] == ["judge"]
