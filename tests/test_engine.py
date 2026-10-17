from prism.rules.engine import evaluate
from prism.schemas import Asset, DecisionStatus, Interpretation, Premise
from tests.factories import make_sheet


def methods(rf, stream="s1"):
    return {c.method for c in rf.top(stream, 2)}


def test_powder_pharma_prefers_nir_and_raman(kb):
    rf = evaluate(make_sheet(matrix="powder", targets=("API concentration",), domain="pharma"), kb)
    assert rf.status == DecisionStatus.PROVISIONAL
    assert methods(rf) == {"NIR", "Raman"}
    nir = next(c for c in rf.candidates if c.technique_id == "nir_diffuse_reflection_probe")
    assert nir.evidence == 2.0 and "S01-p14-blend-potency" in nir.evidence_ids


def test_unknown_optics_creates_decision_changing_question(kb):
    rf = evaluate(make_sheet(matrix="liquid", optics="unknown", targets=("protein",), domain="dairy_food",
                             distance="at_process"), kb)
    seed = next(q for q in rf.question_seeds if q.slot == "streams.s1.optics")
    assert seed.impact in ("PRIMARY_METHOD_CHANGE", "TECHNIQUE_CHANGE")
    assert set(seed.outcomes) == {"clear", "turbid", "opaque"}


def test_undefined_target_is_insufficient_and_asks_first(kb):
    rf = evaluate(make_sheet(targets=("a contaminant",), undefined_targets=True), kb)
    assert rf.status == DecisionStatus.INSUFFICIENT_INFORMATION
    assert rf.question_seeds[0].impact == "STATUS_CHANGE"


def test_clinical_and_gas_are_outside_scope(kb):
    assert evaluate(make_sheet(matrix="tissue", use_context="clinical"), kb).status == \
        DecisionStatus.OUTSIDE_SUPPORTED_SCOPE
    assert evaluate(make_sheet(matrix="gas"), kb).status == DecisionStatus.OUTSIDE_SUPPORTED_SCOPE


def test_vague_enquiry_is_insufficient_but_has_candidates(kb):
    rf = evaluate(make_sheet(matrix="unknown", targets=(), certainty="unknown"), kb)
    assert rf.status == DecisionStatus.INSUFFICIENT_INFORMATION
    assert any(not c.blocked for c in rf.candidates)          # a SCREENING recommendation is possible


def test_approval_request_with_open_decisive_question_is_insufficient(kb):
    sheet = make_sheet(matrix="liquid", targets=("solvent content",), certainty="approve", distance="unknown",
                       premises=(Premise(type="reuse_asset", text="reuse the cable", method="MIR", quote="reuse"),),
                       assets=(Asset(kind="fiber", description="silica fiber", quote="silica"),))
    rf = evaluate(sheet, kb)
    assert rf.status == DecisionStatus.INSUFFICIENT_INFORMATION
    assert any(f.rule_id == "R-FIBER-WINDOW" and f.severity.value == "blocking" for f in rf.findings)


def test_fluorescence_blocked_without_fluorophore(kb):
    rf = evaluate(make_sheet(matrix="liquid", targets=("lactose",), domain="dairy_food"), kb)
    assert all(c.blocked for c in rf.candidates if c.method == "Fluorescence")


def test_remote_distance_penalises_mid_infrared_only(kb):
    rf = evaluate(make_sheet(matrix="liquid", targets=("water content",), distance="remote"), kb)
    mir = next(c for c in rf.candidates if c.method == "MIR")
    nir = next(c for c in rf.candidates if c.method == "NIR")
    assert mir.link == 0.5 and nir.link == 1.0


def test_ambiguous_term_becomes_question(kb):
    sheet = make_sheet(matrix="powder", targets=("moisture",))
    sheet.interpretations = [Interpretation(term="IR", kind="method", alternatives=["NIR", "MIR"], ambiguous=True)]
    rf = evaluate(sheet, kb)
    assert any(q.slot == "term:IR" and "NIR or MIR" in q.text_hint for q in rf.question_seeds)
