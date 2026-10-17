from prism.rules.base import REGISTRY, RuleContext, run_all
from prism.rules.premises import cal_scope, clinical_scope, evidence_scope, fluorophore, undefined_target
from prism.rules.process import aqueous, combination, hot_fouling, link_length, od_not_viability
from prism.schemas import Asset, DecisionStatus, Premise, PremiseVerdict, Severity
from tests.factories import make_sheet


def ctx(kb, **kw):
    return RuleContext(make_sheet(**kw), kb)


def test_registry_matches_rule_metadata(kb):
    run_all(ctx(kb))
    assert set(REGISTRY) == set(kb.rules_meta)


def test_calibration_transfer_is_unverifiable(kb):
    p = Premise(type="transfer_calibration", text="reuse the calibration for a new blend", quote="reuse")
    f = cal_scope(ctx(kb, premises=(p,)))[0]
    assert f.premise_verdict == PremiseVerdict.UNVERIFIABLE and f.question_impact == "PRIMARY_METHOD_CHANGE"


def test_fluorescence_without_fluorophore_is_blocked(kb):
    p = Premise(type="method_preselected", text="use our fluorescence instrument", method="Fluorescence",
                quote="fluorescence")
    f = fluorophore(ctx(kb, targets=("lactose",), premises=(p,)))[0]
    assert f.premise_verdict == PremiseVerdict.UNVERIFIABLE and f.blocks == ["s1:Fluorescence:*"]


def test_fluorescence_for_nadh_is_allowed(kb):
    assert fluorophore(ctx(kb, targets=("NADH level",))) == []


def test_quote_as_proof_for_readiness_is_contradicted(kb):
    p = Premise(type="quote_as_proof", text="the study proves readiness", quote="proves")
    f = evidence_scope(ctx(kb, premises=(p,), certainty="approve"))[0]
    assert f.premise_verdict == PremiseVerdict.CONTRADICTED
    assert "S03-p14-proof-of-concept" in f.evidence_ids


def test_undefined_target_gates_insufficient(kb):
    f = undefined_target(ctx(kb, targets=("an unknown contaminant",), undefined_targets=True))[0]
    assert f.severity == Severity.gate and f.status == DecisionStatus.INSUFFICIENT_INFORMATION
    assert f.question_impact == "STATUS_CHANGE"


def test_clinical_use_is_outside_scope(kb):
    f = clinical_scope(ctx(kb, use_context="clinical"))[0]
    assert f.status == DecisionStatus.OUTSIDE_SUPPORTED_SCOPE


def test_remote_analyzer_warns_about_link_length(kb):
    f = link_length(ctx(kb, distance="remote"))[0]
    assert f.severity == Severity.warning and "S02-p09-short-ir-cables" in f.evidence_ids
    assert link_length(ctx(kb, distance="at_process")) == []


def test_hot_interface_warns(kb):
    assert hot_fouling(ctx(kb, process_conditions="hot melt with deposits"))[0].severity == Severity.warning


def test_aqueous_and_viability_and_combination(kb):
    assert aqueous(ctx(kb, matrix="liquid", domain="bioprocess"))[0].evidence_ids == ["S01-p16-raman-aqueous"]
    assert od_not_viability(ctx(kb, targets=("viable cell count",)))[0].severity == Severity.warning
    p = Premise(type="method_preselected", text="add Raman", method="Raman", quote="Raman")
    a = Asset(kind="instrument", description="NIR analyzer", method="NIR", quote="NIR")
    assert combination(ctx(kb, premises=(p,), assets=(a,)))[0].severity == Severity.warning
