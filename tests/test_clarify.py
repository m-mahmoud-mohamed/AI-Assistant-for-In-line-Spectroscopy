"""The clarify gate: questions ranked by what the engine's what-if says each answer would change, options with their
effects, answers applied without a model call, 'not known yet' never asked twice, and 'Other...' text mapped to an
allowed value."""
from __future__ import annotations

import time
from pathlib import Path

import pytest

from prism.assist.clarify import (
    ASK_LIMIT,
    NO_CHANGE,
    MappedAnswer,
    Outcome,
    decision_text,
    effects,
    load_ontology,
    rank_questions,
    to_ask,
)
from prism.assist.sections import with_application_candidates
from prism.assist.workflow import PipelineFlags, Workflow
from prism.cases import sha256_text
from prism.rules.engine import IMPACT_ORDER, evaluate, evaluate_quick
from prism.schemas import PREMISE_TYPES, ClarifyQuestion, DecisionStatus, Enquiry, Interpretation, Premise
from tests.factories import make_sheet
from tests.fakes import FakeGateway, workflow_fake

KB = Path(__file__).resolve().parents[1] / "kb"
MAT = Path(__file__).resolve().parents[1] / "materials"
FAT = "We need to monitor fat in a liquid dairy stream with a fiber probe. What should we test first?"
CONTAMINANT = ("We need to detect an unknown contaminant in a liquid stream with a fiber probe and NIR or Raman. "
               "What should we test first?")


@pytest.fixture(scope="module")
def onto():
    return load_ontology(KB)


def engine(kb):
    return lambda s: with_application_candidates(evaluate(s, kb), s, kb)


def quick(kb):
    return lambda s: with_application_candidates(evaluate_quick(s, kb), s, kb)


def gate(kb, onto, sheet):
    return rank_questions(sheet, engine(kb)(sheet), kb, quick(kb), onto)


def enquiry(text):
    return Enquiry(case_id="C1", title="Clarify", text=text, sha256=sha256_text(text))


def by_slot(questions, slot) -> ClarifyQuestion:
    return next(q for q in questions if q.slot == slot)


# ---------------------------------------------------------------- the engine's what-if

SHEETS = {
    "liquid": {"matrix": "liquid", "optics": "unknown", "domain": "dairy_food", "targets": ("fat",)},
    "unknown": {"matrix": "unknown", "optics": "unknown"},
    "approve": {"matrix": "unknown", "certainty": "approve"},
    "undefined": {"matrix": "liquid", "targets": ("an unknown contaminant",), "undefined_targets": True},
}


@pytest.mark.parametrize("name", SHEETS)
def test_the_quick_engine_decides_exactly_like_the_full_one(kb, name):
    sheet = make_sheet(**SHEETS[name])
    full, fast = evaluate(sheet, kb), evaluate_quick(sheet, kb)
    assert (fast.status, fast.findings, fast.candidates) == (full.status, full.findings, full.candidates)
    assert fast.question_seeds == []


# ---------------------------------------------------------------- ranking

def test_an_undefined_target_is_asked_first_and_can_change_the_status(kb, onto):
    questions = gate(kb, onto, make_sheet(**SHEETS["undefined"]))
    first = questions[0]
    assert first.slot == "streams.s1.targets" and first.impact == "STATUS_CHANGE"
    effect = {o.value: o.effect for o in first.options}
    assert effect["defined"] == "status → provisional assessment" and effect["undefined"] == NO_CHANGE


def test_an_unknown_optical_state_changes_the_probe_geometry(kb, onto):
    questions = gate(kb, onto, make_sheet(**SHEETS["liquid"]))
    optics = by_slot(questions, "streams.s1.optics")
    assert IMPACT_ORDER.index(optics.impact) <= IMPACT_ORDER.index("TECHNIQUE_CHANGE")
    effect = {o.value: o.effect for o in optics.options}
    assert "diffuse reflection" in effect["opaque"] and "transmission" in effect["clear"]
    assert [o.value for o in optics.options] == ["clear", "turbid", "opaque", "variable"]
    assert optics.text and optics.why and optics.stream_id == "s1"


def test_ranking_is_deterministic_and_well_formed(kb, onto):
    for spec in SHEETS.values():
        sheet = make_sheet(**spec)
        first, again = gate(kb, onto, sheet), gate(kb, onto, sheet)
        assert first == again and first
        assert all(2 <= len(q.options) <= 5 and q.text and q.why for q in first)
        assert len({q.slot for q in first}) == len(first)


def test_known_slots_are_not_asked(kb, onto):
    sheet = make_sheet(matrix="liquid", optics="clear", distance="at_process", use_context="production",
                       domain="dairy_food", process_conditions="mild and clean conditions")
    slots = {q.slot for q in gate(kb, onto, sheet)}
    assert not slots & {"streams.s1.matrix", "streams.s1.optics", "distance", "use_context", "domain",
                        "process_conditions"}


def test_an_ambiguous_term_offers_its_readings(kb, onto):
    sheet = make_sheet(matrix="liquid", optics="clear")
    sheet.interpretations = [Interpretation(term="IR", kind="method", alternatives=["NIR", "MIR"], ambiguous=True)]
    q = by_slot(gate(kb, onto, sheet), "term:IR")
    assert q.impact == "PRIMARY_METHOD_CHANGE" and "IR" in q.text
    assert [(o.value, o.label) for o in q.options] == [("NIR", "NIR (near infrared)"), ("MIR", "Mid-infrared (MIR)")]


def test_per_stream_questions_name_their_stream(kb, onto):
    from prism.schemas import Stream, Target
    from tests.factories import _fact
    streams = [Stream(id=sid, name=name, targets=[Target(name="water", defined=True, quote="water")],
                      matrix=_fact("liquid"), optics=_fact("unknown")) for sid, name in (("s1", "feed"), ("s2", "product"))]
    questions = gate(kb, onto, make_sheet(streams=streams))
    optics = [q for q in questions if q.slot.endswith(".optics")]
    assert {q.stream_id for q in optics} == {"s1", "s2"}
    assert any("(stream product)" in q.text for q in optics)


def test_to_ask_keeps_decision_changing_questions_and_skips_deferred(kb, onto):
    questions = gate(kb, onto, make_sheet(**SHEETS["unknown"]))
    ask = to_ask(questions)
    assert 0 < len(ask) <= ASK_LIMIT and all(q.impact != "RISK_ONLY" for q in ask)
    assert ask == [q for q in questions if q.impact != "RISK_ONLY"][:ASK_LIMIT]
    later = to_ask(questions, deferred=[ask[0].slot])
    assert ask[0].slot not in {q.slot for q in later}


def test_the_whole_gate_is_fast(kb, onto):
    sheet = make_sheet(**SHEETS["approve"])            # the slowest kind: every what-if checks for decisive unknowns
    findings = engine(kb)(sheet)
    gate(kb, onto, sheet)                               # warm caches
    t0 = time.perf_counter()
    rank_questions(sheet, findings, kb, quick(kb), onto)
    assert time.perf_counter() - t0 < 0.5               # budget 200 ms; generous for slow CI machines


# ---------------------------------------------------------------- effects in words

def outcome_of(status=DecisionStatus.PROVISIONAL, leads=(("s1", "NIR", "nir_refl"),), short=(), blocked=(), risks=()):
    return Outcome(status, tuple(leads), frozenset(short), frozenset(blocked), frozenset(risks), (),
                   {"nir_refl": "NIR diffuse reflection probe", "raman": "Raman probe", "mir_atr": "MIR ATR probe"})


def test_effects_name_the_most_significant_change_first(onto):
    sheet = make_sheet()
    base = outcome_of()
    assert effects(base, outcome_of(DecisionStatus.INSUFFICIENT_INFORMATION), sheet, onto) == [
        "status → insufficient information"]
    assert effects(base, outcome_of(leads=(("s1", "Raman", "raman"),)), sheet, onto) == ["primary method → Raman"]
    assert effects(base, outcome_of(risks={("R-LINK-LENGTH", "")}), sheet, onto) == ["adds risk: a long fiber link"]
    assert effects(base, outcome_of(blocked={("s1", "mir_atr")}), sheet, onto) == ["blocks MIR ATR probe"]
    assert effects(base, base, sheet, onto) == []


def test_premise_verdicts_show_up_in_effects(kb, onto):
    sheet = make_sheet(matrix="liquid", optics="clear",
                       premises=(Premise(type=PREMISE_TYPES[0], text="The fiber carries MIR.",
                                          quote="The fiber carries MIR."),))
    base = Outcome(DecisionStatus.PROVISIONAL, (), frozenset(), frozenset(), frozenset(), ((0, "SUPPORTED"),), {})
    after = Outcome(DecisionStatus.PROVISIONAL, (), frozenset(), frozenset(), frozenset(), ((0, "CONTRADICTED"),), {})
    assert effects(base, after, sheet, onto) == ["premise “The fiber carries MIR.” → contradicted"]


def test_decision_text_names_what_the_options_change():
    q = ClarifyQuestion(id="distance", slot="distance", text="How far?", why="Link length.",
                        impact="PRIMARY_METHOD_CHANGE", options=[
                            {"value": "at_process", "label": "Short", "effect": "primary method → MIR"},
                            {"value": "remote", "label": "Far", "effect": NO_CHANGE}])
    assert decision_text(q) == "Which method is recommended first (Short: primary method → MIR)"


# ---------------------------------------------------------------- the workflow

def test_prepare_offers_the_top_questions_and_engine_ready_carries_them(kb):
    sheet = make_sheet(**SHEETS["liquid"])
    events = []
    wf = Workflow(workflow_fake(sheet), kb, PipelineFlags(), emit=events.append, materials=MAT)
    prepared = wf.prepare(enquiry(FAT))
    assert prepared.questions and len(prepared.questions) <= ASK_LIMIT
    assert prepared.questions[0].slot == "streams.s1.optics"
    assert all(q.impact != "RISK_ONLY" for q in prepared.questions)
    assert len(prepared.ranked) >= len(prepared.questions)
    ready = next(e for e in events if e["type"] == "engine_ready")
    shown = [ClarifyQuestion.model_validate(q) for q in ready["payload"]["questions"]]
    assert shown == prepared.questions
    assert prepared.preview()["questions"] == ready["payload"]["questions"]
    # the report's questions are led by the gate, 3-6 of them with unique ordered priorities
    report_qs = prepared.skeleton.questions
    assert 3 <= len(report_qs) <= 6 and [q.priority for q in report_qs] == list(range(1, len(report_qs) + 1))
    assert report_qs[0].slot == "streams.s1.optics" and report_qs[0].impact == prepared.questions[0].impact
    assert "Opaque" in report_qs[0].decision_it_changes


def test_answer_drops_the_answered_slot_with_no_model_call(kb):
    sheet = make_sheet(**SHEETS["liquid"])
    gw = workflow_fake(sheet)
    wf = Workflow(gw, kb, PipelineFlags(), materials=MAT)
    prepared = wf.prepare(enquiry(FAT))
    calls = len(gw.requests)
    t0 = time.perf_counter()
    after = wf.answer(prepared, "streams.s1.optics", "Opaque")       # values are matched without case
    assert time.perf_counter() - t0 < 0.3 and len(gw.requests) == calls
    assert after.confirmed == {"streams.s1.optics": "opaque"}
    assert "streams.s1.optics" not in {q.slot for q in after.ranked} | {q.slot for q in after.skeleton.questions}
    assert "diffuse reflection" in after.findings.top("s1", 1)[0].technique
    with pytest.raises(ValueError):
        wf.answer(prepared, "streams.s1.optics", "foggy")
    with pytest.raises(ValueError):
        wf.answer(prepared, "streams.s9.optics", "clear")


def test_not_known_yet_stays_open_in_the_report_but_is_not_asked_again(kb):
    sheet = make_sheet(**SHEETS["liquid"])
    wf = Workflow(workflow_fake(sheet), kb, PipelineFlags(), materials=MAT)
    prepared = wf.prepare(enquiry(FAT))
    first = prepared.questions[0].slot
    after = wf.answer(prepared, first, "unknown")
    assert after.deferred == [first] and first not in after.confirmed
    assert first not in {q.slot for q in after.questions}
    assert first in {q.slot for q in after.skeleton.questions}                 # still a question for the client
    assert after.findings.status == prepared.findings.status
    # answering it later still works and clears the deferral
    later = wf.answer(after, first, "clear")
    assert later.deferred == [] and later.confirmed == {first: "clear"}


def test_free_text_targets_are_the_scientists_own_words(kb):
    wf = Workflow(workflow_fake(make_sheet(**SHEETS["undefined"])), kb, PipelineFlags(), materials=MAT)
    prepared = wf.prepare(enquiry(CONTAMINANT))
    assert prepared.questions[0].slot == "streams.s1.targets"
    after = wf.answer(prepared, "streams.s1.targets", "defined")
    assert after.findings.status == DecisionStatus.PROVISIONAL


# ---------------------------------------------------------------- "Other..." free text

def test_answer_text_needs_no_model_for_an_exact_label(kb):
    sheet = make_sheet(**SHEETS["liquid"])
    gw = workflow_fake(sheet)
    wf = Workflow(gw, kb, PipelineFlags(), materials=MAT)
    prepared = wf.prepare(enquiry(FAT))
    calls = len(gw.requests)
    after = wf.answer_text(prepared, "streams.s1.optics", "clear liquid")
    assert len(gw.requests) == calls and after.confirmed == {"streams.s1.optics": "clear"}


def test_answer_text_maps_words_with_one_classifier_call(kb):
    sheet = make_sheet(**SHEETS["liquid"])
    gw = workflow_fake(sheet, classifier=[MappedAnswer(value="opaque"), MappedAnswer(value="purple"),
                                          MappedAnswer(value="whey protein")])
    wf = Workflow(gw, kb, PipelineFlags(), materials=MAT)
    prepared = wf.prepare(enquiry(FAT))
    after = wf.answer_text(prepared, "streams.s1.optics", "white like milk, you cannot see through it")
    assert after.confirmed == {"streams.s1.optics": "opaque"}
    assert [r["role"] for r in gw.requests].count("classifier") == 1
    assert "white like milk" in gw.requests[-1]["messages"][0]["content"]
    # a value outside the ontology is never stored: it counts as 'not known yet'
    unsure = wf.answer_text(prepared, "distance", "somewhere in the building, I think")
    assert unsure.confirmed == {} and unsure.deferred == ["distance"]
    # a free-text slot keeps a name only when it is the scientist's own words
    undefined = Workflow(FakeGateway({"classifier": [MappedAnswer(value="whey protein")]}), kb, PipelineFlags(),
                         materials=MAT)
    from prism.assist.clarify import map_text
    sheet_u = make_sheet(**SHEETS["undefined"])
    assert map_text(undefined.gateway, undefined.ontology, sheet_u, "streams.s1.targets",
                    "it is whey protein from the separator") == "whey protein"
    assert map_text(FakeGateway({"classifier": [MappedAnswer(value="casein")]}), undefined.ontology, sheet_u,
                    "streams.s1.targets", "it is whey protein from the separator") == "unknown"


def test_answer_text_rejects_an_unknown_slot(kb):
    wf = Workflow(workflow_fake(make_sheet(**SHEETS["liquid"])), kb, PipelineFlags(), materials=MAT)
    prepared = wf.prepare(enquiry(FAT))
    with pytest.raises(ValueError):
        wf.answer_text(prepared, "no_such_slot", "whatever")


# ---------------------------------------------------------------- batch mode

def test_a_batch_run_records_the_questions_and_never_waits(kb):
    from prism.orchestrator import Pipeline
    sheet = make_sheet(**SHEETS["liquid"])
    result = Pipeline(workflow_fake(sheet), kb, MAT, PipelineFlags()).run(enquiry(FAT))
    qs = result.report.clarification_questions
    assert 3 <= len(qs) <= 6 and result.report.compliance["P-QUESTIONS"] is True
    assert qs[0].priority == 1 and "probe geometry" in qs[0].decision_it_changes
