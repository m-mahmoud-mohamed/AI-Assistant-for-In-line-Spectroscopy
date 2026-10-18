"""The assessment workflow (prepare / answer / write): skeleton, parallel writers, verification cascade, patching,
events. FakeGateway only, no network."""
import time
from dataclasses import replace
from pathlib import Path

import pytest

from prism.assist.patch import MAX_ROUNDS, PatchItem, apply_item, patch_body
from prism.assist.sections import (
    SECTION_PATHS,
    AnswerSection,
    ConceptProse,
    ConceptSection,
    PlanProse,
    PlanSection,
    QuestionProse,
    RecProse,
    RiskProse,
    build_skeleton,
    merge,
    slice_issues,
    slice_pack,
    with_application_candidates,
)
from prism.assist.workflow import Workflow, apply_confirmed
from prism.cases import sha256_text
from prism.orchestrator import Pipeline, PipelineFlags
from prism.rules.engine import evaluate
from prism.schemas import (
    CONFIRMED_QUOTE,
    Asset,
    ClaimType,
    DecisionStatus,
    Enquiry,
    Fact,
    Issue,
    Premise,
    RecRole,
    SpectralRange,
    Stream,
    Target,
    iter_segments,
)
from prism.stages.checks import CheckContext, NumberGuard, check_numbers, run_checks
from prism.stages.retrieve import Retriever
from prism.stages.verify import gate_issues, judge_claims, load_judge_examples, verify
from tests.factories import make_sheet, minimal_body, seg
from tests.fakes import FakeGateway, workflow_fake

MAT = Path(__file__).resolve().parents[1] / "materials"
TEXT = ("We need to monitor fat and protein in an opaque liquid dairy stream with a fiber probe. "
        "What should we test first?")
UNDEFINED_TEXT = ("We need to detect an unknown contaminant in a liquid stream with a fiber probe and NIR or Raman. "
                  "What should we test first?")
DAIRY = {"matrix": "liquid", "optics": "opaque", "domain": "dairy_food", "targets": ("fat", "protein")}


def enquiry(text=TEXT):
    return Enquiry(case_id="W1", title="Dairy", text=text, sha256=sha256_text(text))


def dairy_sheet(**kw):
    sheet = make_sheet(**{**DAIRY, **kw})
    return sheet


def context(kb, sheet=None, source_texts=(TEXT + " compare",)):
    sheet = sheet or dairy_sheet()
    findings = with_application_candidates(evaluate(sheet, kb), sheet, kb)
    pack = Retriever(kb).pack(sheet, findings)
    sk = build_skeleton(sheet, findings, kb)
    return sheet, findings, pack, sk, slice_pack(pack, sk, findings, kb), list(source_texts)


# ---------------------------------------------------------------- the skeleton

def test_skeleton_is_complete_before_any_writer_runs(kb):
    sheet, findings, _, sk, _, _ = context(kb)
    assert sk.status == DecisionStatus.PROVISIONAL
    assert next((r.role, r.methods, r.technique) for r in sk.recs) == (
        RecRole.PRIMARY, ["NIR"], "diffuse reflection probe")
    assert all(r.applies_to == ["s1"] and r.fallback and r.evidence_ids for r in sk.recs)
    assert 3 <= len(sk.questions) <= 6 and [q.priority for q in sk.questions] == list(range(1, len(sk.questions) + 1))
    assert all(q.decision_it_changes and q.why and q.question for q in sk.questions)
    assert [c.stream_id for c in sk.concepts] == ["s1"] and sk.concepts[0].probe_geometry
    assert sk.concepts[0].fiber_link and sk.concepts[0].location
    assert [r.method for r in sk.ranges] == sk.recommended_methods() == ["NIR"]
    assert {f.slot for f in sk.requirements.stated_facts} >= {"streams.s1.matrix", "streams.s1.optics"}
    assert set(sk.plan.defaults) == {"samples_and_states", "reference_measurements", "setup", "comparison",
                                     "validation", "go_no_go", "not_demonstrated"}
    assert 1 <= len(sk.plan.steps) <= 6 and sk.plan.decision_basis and sk.plan.objective
    assert build_skeleton(sheet, findings, kb) == sk                      # deterministic


def test_empty_writer_output_still_merges_to_a_valid_checked_body(kb):
    sheet, findings, pack, sk, slices, sources = context(kb)
    body = merge(sk, kb, pack, {}, slices).body
    issues = run_checks(CheckContext(body, sheet, findings, pack, kb, sources))
    assert [i for i in issues if i.severity == "error"] == []
    assert body.decision_status == sk.status and len(body.clarification_questions) == len(sk.questions)


def test_skeleton_screens_when_the_target_is_undefined(kb):
    sheet = make_sheet(matrix="liquid", targets=("an unknown contaminant",), undefined_targets=True)
    findings = with_application_candidates(evaluate(sheet, kb), sheet, kb)
    sk = build_skeleton(sheet, findings, kb)
    assert sk.status == DecisionStatus.INSUFFICIENT_INFORMATION
    assert [r.role for r in sk.recs] == [RecRole.SCREENING] and len(sk.recs[0].methods) >= 2
    assert sk.questions[0].impact == "STATUS_CHANGE" and sk.questions[0].slot == "R-UNDEFINED-TARGET"


def test_two_streams_get_two_concepts_and_scoped_recommendations(kb):
    streams = [Stream(id="s1", name="feed", targets=[Target(name="water content", quote="water content")],
                      matrix=Fact(value="liquid", quote="liquid"), optics=Fact(value="clear", quote="clear")),
               Stream(id="s2", name="powder", targets=[Target(name="API", quote="API")],
                      matrix=Fact(value="powder", quote="powder"))]
    sheet = make_sheet(streams=streams, domain="pharma")
    findings = with_application_candidates(evaluate(sheet, kb), sheet, kb)
    sk = build_skeleton(sheet, findings, kb)
    assert [c.stream_id for c in sk.concepts] == ["s1", "s2"]
    assert {sid for r in sk.recs for sid in r.applies_to} == {"s1", "s2"}


def test_a_fiber_the_rules_blocked_is_not_named_again_in_the_concept(kb):
    sheet = make_sheet(matrix="liquid", domain="petrochemical", targets=("water content",),
                       premises=(Premise(type="reuse_asset", text="Reuse the silica link", method="MIR",
                                         quote="silica link"),),
                       assets=(Asset(kind="fiber", description="existing silica fiber", method="MIR",
                                     quote="silica fiber"),))
    findings = with_application_candidates(evaluate(sheet, kb), sheet, kb)
    sk = build_skeleton(sheet, findings, kb)
    assert any(f.rule_id == "R-FIBER-WINDOW" and f.severity.value == "blocking" for f in findings.findings)
    assert sk.premises and sk.premises[0].verdict.value == "CONTRADICTED"
    pack = Retriever(kb).pack(sheet, findings)
    merged = merge(sk, kb, pack, {}, slice_pack(pack, sk, findings, kb))
    issues = run_checks(CheckContext(merged.body, sheet, findings, pack, kb, ["silica link silica fiber"]))
    assert not [i for i in issues if i.check_id == "C-FINDINGS"]
    assert "silica" not in merged.body.measurement_concept[0].fiber_link.lower()


def test_evidence_slices_are_bounded_and_distinct(kb):
    _, _, pack, _, slices, _ = context(kb)
    for cards in slices.values():
        assert 8 <= len(cards) <= 15 and {c.id for c in cards} <= pack.ids()
    assert len({tuple(c.id for c in cards) for cards in slices.values()}) == 3


# ---------------------------------------------------------------- merging the writers

def test_writers_merge_into_a_valid_report_body(kb):
    sheet, findings, pack, sk, slices, sources = context(kb)
    cite = lambda section: [c.id for c in slices[section] if c.source == "S01"][:1]  
    answer = AnswerSection(
        recommendations=[RecProse(rec_id=sk.recs[0].id, rationale=[
            seg("In-line NIR reflection is used for opaque or concentrated dairy products.", ClaimType.AFS,
                ["S01-p17-nir-reflection-opaque"])], conditions=[seg("A representative sample must reach the probe.",
                                                                    ClaimType.ASSUMPTION)])],
        direct_answer=[seg("A reflection probe on NIR is the first option to test.", ClaimType.PROPOSAL)],
        verdict="CONDITIONAL")
    concept = ConceptSection(
        concepts=[ConceptProse(stream_id="s1", notes=[seg("Confirm fouling and cleaning with AFS.")])],
        risks=[RiskProse(risk=[seg("Temperature changes can mimic composition changes.", ClaimType.ASSUMPTION)],
                         effect="biased predictions", mitigation="vary temperature in the design")])
    plan = PlanSection(
        questions=[QuestionProse(question_id="q1", question="Which concentration range matters for fat?",
                                 why_it_matters="It sets the sensitivity needed.")],
        plan=PlanProse(objective="Compare NIR geometries on dairy samples.", steps=["Clarify", "Sample", "Measure"],
                       go_no_go=[seg("The client agrees the criteria before the test.")]),
        decision_basis=[seg("Compare error and bias on independent runs.")])
    drafts = {"answer": answer, "concept": concept, "plan": plan}
    body = merge(sk, kb, pack, drafts, slices).body
    assert body.recommendations[0].rationale[0].evidence_ids == ["S01-p17-nir-reflection-opaque"]
    assert body.recommendations[0].conditions[0].claim_type == ClaimType.ASSUMPTION
    assert body.recommendations[1].rationale                                           # not written: filled by code
    assert body.direct_answer.text[0].text.startswith("A reflection probe") and body.direct_answer.verdict.value == "CONDITIONAL"
    assert body.measurement_concept[0].notes[0].text == "Confirm fouling and cleaning with AFS."
    assert body.measurement_concept[0].probe_geometry == sk.concepts[0].probe_geometry     # code-owned
    assert body.clarification_questions[0].question == "Which concentration range matters for fat?"
    assert body.clarification_questions[1].question == sk.questions[1].question          # untouched stays code wording
    assert body.feasibility_plan.objective.startswith("Compare NIR") and body.feasibility_plan.steps == [
        "Clarify", "Sample", "Measure"]
    assert body.feasibility_plan.go_no_go[0].text.startswith("The client agrees")
    assert body.feasibility_plan.validation[0].claim_type == ClaimType.PROPOSAL          # template default
    assert [r.text for r in body.risks[0].risk] == ["Temperature changes can mimic composition changes."]
    issues = run_checks(CheckContext(body, sheet, findings, pack, kb, sources))
    assert [i for i in issues if i.severity == "error"] == []
    assert sorted(SECTION_PATHS) == ["answer", "concept", "plan"] and cite("answer")


def test_a_writer_cannot_change_status_methods_or_roles(kb):
    _, _, pack, sk, slices, _ = context(kb)
    answer = AnswerSection(recommendations=[RecProse(rec_id="r99", rationale=[seg("Use Raman everywhere.")])],
                           direct_answer=[seg("Yes, certainly.")], verdict="YES")
    body = merge(sk, kb, pack, {"answer": answer}, slices).body
    assert body.decision_status == sk.status
    assert [(r.methods, r.technique, r.role) for r in body.recommendations] == [
        (r.methods, r.technique, r.role) for r in sk.recs]


def test_the_engine_status_caps_the_writers_verdict(kb):
    sheet = make_sheet(matrix="liquid", targets=("an unknown contaminant",), undefined_targets=True)
    findings = with_application_candidates(evaluate(sheet, kb), sheet, kb)
    pack = Retriever(kb).pack(sheet, findings)
    sk = build_skeleton(sheet, findings, kb)
    body = merge(sk, kb, pack, {"answer": AnswerSection(direct_answer=[seg("Fine.")], verdict="YES")}, {}).body
    assert body.direct_answer.verdict.value == "CONDITIONAL" and body.decision_status == sk.status


def test_a_card_outside_the_writers_slice_is_rejected(kb):
    sheet, findings, pack, sk, slices, sources = context(kb)
    outside = next(c.id for c in pack.cards if c.id not in {x.id for x in slices["answer"]})
    answer = AnswerSection(recommendations=[RecProse(rec_id="r1", rationale=[
        seg("In-line NIR reflection is used for opaque or concentrated dairy products.", ClaimType.AFS, [outside]),
        seg("A reflection probe suits opaque products.", ClaimType.AFS, ["S01-p17-nir-reflection-opaque"])])])
    merged = merge(sk, kb, pack, {"answer": answer}, slices)
    first, second = merged.body.recommendations[0].rationale[:2]
    assert first.evidence_ids == [] and second.evidence_ids == ["S01-p17-nir-reflection-opaque"]
    assert slice_issues(merged) == [("recommendations[0].rationale[0]",
                                     f"cites {outside}, outside the evidence given to its writer; citation removed")]
    errors = [i for i in run_checks(CheckContext(merged.body, sheet, findings, pack, kb, sources))
              if i.severity == "error"]
    assert [(i.check_id, i.path) for i in errors] == [("C-IDS", "recommendations[0].rationale[0]")]


def test_writer_numbers_must_come_from_the_enquiry_or_code(kb):
    _, _, pack, sk, slices, sources = context(kb)
    guard = NumberGuard(sources, [r.nominal_range for r in sk.ranges])
    plan = PlanSection(questions=[QuestionProse(question_id="q1", question="Is 99.5 % purity needed?")],
                       plan=PlanProse(objective="Reach 0.01 % error.", steps=["Hit 3 sigma at 250 nm"]))
    body = merge(sk, kb, pack, {"plan": plan}, slices, guard).body
    assert body.clarification_questions[0].question == sk.questions[0].question
    assert body.feasibility_plan.objective == sk.plan.objective and body.feasibility_plan.steps == sk.plan.steps


# ---------------------------------------------------------------- the number guard

def test_number_guard_is_unit_aware():
    guard = NumberGuard(["The line runs at 25 °C and the cable is 40 m long."],
                        ["780–2500 nm", "4000–400 cm⁻¹ (2.5–25 µm)"])
    assert guard.bad("The cable is 40 m long.") == []
    assert guard.bad("The medium is at 298.15 K.") == []                       # °C <-> K
    assert guard.bad("The method covers 0.78 to 2.5 µm.") == []                # nm <-> µm
    assert guard.bad("Bands near 5000 cm-1 are overtones.", cited="NIR spectra (780–2500 nm)") == ["5000"]
    assert guard.bad("The window is 1.54 µm.", cited="a band at 6500 cm-1") == []     # 1.54 µm = 6500 cm-1
    assert guard.bad("The error is below 0.05 %.") == ["0.05"]                 # invented
    assert guard.bad("The probe is 12 m away.") == ["12"]


def test_number_guard_accepts_computed_range_fields_in_the_checks(kb):
    sheet, findings, pack, sk, slices, sources = context(kb)
    body = merge(sk, kb, pack, {}, slices).body
    body.decision_basis.append(seg("NIR covers 0.78–2.5 µm, here 12820–4000 cm⁻¹.", ClaimType.PROPOSAL))
    cx = CheckContext(body, sheet, findings, pack, kb, sources, [r.nominal_range for r in sk.ranges])
    assert check_numbers(cx) == []
    body.decision_basis.append(seg("Expect an error below 0.05 %."))
    assert [i.path for i in check_numbers(cx)] == ["decision_basis[2]"]


def test_excitation_is_a_number_or_null():
    base = {"method": "Raman", "nominal_range": "x", "units": "cm⁻¹", "fiber_family_needed": "y"}
    assert SpectralRange(**base, excitation_nm=785).excitation_nm == 785.0
    assert SpectralRange(**base, excitation_nm="532 nm").excitation_nm == 532.0
    assert SpectralRange(**base, excitation_nm='{"decision_status": "PROVISIONAL"}').excitation_nm is None
    assert SpectralRange(**base).excitation_nm is None and SpectralRange(**base, excitation_nm="n/a").excitation_nm is None
    assert SpectralRange(**base, excitation_nm=785).model_dump(mode="json")["excitation_nm"] == 785.0


# ---------------------------------------------------------------- the claim-type gate and the judge

def test_only_client_afs_and_external_sentences_need_support(kb):
    _, _, pack, _, _, _ = context(kb)
    body = minimal_body(decision_basis=[
        seg("We assume the product is homogeneous.", ClaimType.ASSUMPTION),
        seg("Start with a laboratory comparison.", ClaimType.PROPOSAL),
        seg("The sampling point is not known.", ClaimType.UNKNOWN),
        seg("NIR covers 780–2500 nm according to the source.", ClaimType.AFS, ["S01-p10-nir-range"]),
        seg("The nominal NIR range is 780–2500 nm.", ClaimType.AFS, ["S01-p10-nir-range"])])
    cards = {c.id: c for c in pack.cards}
    claims = judge_claims(body, cards, set())
    assert {c["path"] for c in claims} >= {"decision_basis[3]"}
    assert not any(c["path"] in ("decision_basis[0]", "decision_basis[1]", "decision_basis[2]") for c in claims)
    assert "decision_basis[4]" not in {c["path"] for c in claims}     # a card's own claim, word for word: not judged
    assert all(c["quotes"] for c in claims)


def test_client_sentences_are_checked_in_code_and_labels_for_honesty():
    sources = ["We produce an opaque milk concentrate and sample it for fat and protein analysis."]
    body = minimal_body(decision_basis=[
        seg("The client produces an opaque milk concentrate and samples it for fat.", ClaimType.CLIENT),
        seg("The client runs a 300 bar steam sterilisation loop.", ClaimType.CLIENT),
        seg("Studies have shown that NIR resolves protein to 0.1 percent.", ClaimType.ASSUMPTION),
        seg("A comparison on retained samples is the first step.", ClaimType.PROPOSAL)])
    issues = gate_issues(body, sources)
    assert [i.path for i in issues] == ["decision_basis[1]", "decision_basis[2]"]
    assert "client's words" in issues[0].message and "published result" in issues[1].message


def test_the_judge_is_called_once_with_every_sentence_and_the_rubric(kb):
    sheet, findings, pack, sk, slices, sources = context(kb)
    body = merge(sk, kb, pack, {"answer": writer_drafts()[AnswerSection]}, slices).body
    claims_expected = judge_claims(body, {c.id: c for c in pack.cards}, set())
    gw = FakeGateway({"judge": [{"verdicts": [{"id": "c1", "verdict": "supported", "reason": "same strength"}]}]})
    report = verify(body, sheet, findings, pack, kb, sources, gw, sheet.client_question)
    assert [r["role"] for r in gw.requests] == ["judge"] and len(claims_expected) == 2
    prompt = gw.requests[0]["messages"][0]["content"]
    assert all(c["text"] in prompt for c in claims_expected)
    assert "supported" in prompt and "partial" in prompt and "unsupported" in prompt
    assert [v.verdict for v in report.verdicts] == ["supported"] and report.passed


def test_deep_mode_uses_the_deep_judge(kb):
    sheet, findings, pack, sk, slices, sources = context(kb)
    body = merge(sk, kb, pack, {"answer": writer_drafts()[AnswerSection]}, slices).body
    gw = FakeGateway({"judge_deep": [{"verdicts": []}]})
    verify(body, sheet, findings, pack, kb, sources, gw, role="judge_deep")
    assert [r["role"] for r in gw.requests] == ["judge_deep"]


def test_judge_examples_are_loaded_from_the_knowledge_base_when_present(kb, tmp_path):
    assert load_judge_examples(replace(kb, root=tmp_path)) == []
    (tmp_path / "judge_examples.yaml").write_text(
        "- claim: NIR works for every dairy product.\n  quotes: [In-line NIR reflection is used for opaque dairy products.]\n"
        "  verdict: partial\n  reason: wider than the quote\n- claim: ignored\n  verdict: maybe\n", encoding="utf-8")
    examples = load_judge_examples(replace(kb, root=tmp_path))
    assert [e["verdict"] for e in examples] == ["partial"]
    sheet, findings, pack, sk, slices, sources = context(kb)
    body = merge(sk, kb, pack, {"answer": writer_drafts()[AnswerSection]}, slices).body
    gw = FakeGateway({"judge": [{"verdicts": []}]})
    verify(body, sheet, findings, pack, replace(kb, root=tmp_path), sources, gw)
    assert "NIR works for every dairy product." in gw.requests[0]["messages"][0]["content"]


# ---------------------------------------------------------------- patching

def segments(body):
    return dict(iter_segments(body))


def run_patch(kb, body, issues, responses, max_rounds=MAX_ROUNDS):
    sheet, findings, pack, _, _, sources = context(kb)
    cards = {c.id: c for c in pack.cards}
    gw = FakeGateway({"patcher": list(responses)})

    def recheck(b, changed):
        return run_checks(CheckContext(b, sheet, findings, pack, kb, sources))

    return patch_body(body, issues, cards, gw, recheck, max_rounds=max_rounds), gw


def test_patch_actions_relabel_hedge_rewrite_delete(kb):
    quote = ("In-line NIR reflection is used for opaque or concentrated dairy products "
             "[S01-p17-nir-reflection-opaque]")
    body = minimal_body(decision_basis=[
        seg("Raman works for every dairy stream.", ClaimType.AFS, ["S01-p17-nir-reflection-opaque"]),
        seg("NIR guarantees correct results.", ClaimType.PROPOSAL),
        seg("This concept ensures reliable results at once.", ClaimType.AFS, ["S01-p17-nir-reflection-opaque"]),
        seg("Bad sentence one.", ClaimType.PROPOSAL)])
    issues = [Issue(check_id="C-SUPPORT", path="decision_basis[0]", message="unsupported: not in the quote"),
              Issue(check_id="P-NO-GUARANTEE", path="decision_basis[1]", message="over-claiming wording"),
              Issue(check_id="P-NO-GUARANTEE", path="decision_basis[2]", message="over-claiming wording"),
              Issue(check_id="P-NO-BAND-PICK", path="decision_basis[3]", message="picks an optimal band")]
    reply = {"patches": [
        {"id": "s1", "action": "relabel", "claim_type": "ASSUMPTION"},
        {"id": "s2", "action": "hedge", "text": "NIR may give useful results."},
        {"id": "s3", "action": "rewrite", "text": "In-line NIR reflection is used for opaque dairy products."},
        {"id": "s4", "action": "delete"}]}
    out, gw = run_patch(kb, body, issues, [reply])
    texts = segments(out.body)
    assert out.rounds == 1 and out.calls == 1 and quote
    assert texts["decision_basis[0]"].claim_type == ClaimType.ASSUMPTION
    assert texts["decision_basis[1]"].text == "NIR may give useful results."
    assert texts["decision_basis[2]"].text.startswith("In-line NIR reflection")
    assert "decision_basis[3]" not in texts and [s.text for s in out.body.decision_basis][-1].startswith("In-line")
    assert [a["action"] for a in out.actions] == ["relabel", "hedge", "rewrite", "delete"]
    assert [i for i in out.issues if i.severity == "error"] == []
    assert len(gw.requests) == 1                      # all four sentences travel in ONE call


def test_patch_proposals_are_capped_and_never_add_numbers():
    seg_ = {"text": "NIR works.", "claim_type": "AFS", "evidence_ids": []}
    assert apply_item(dict(seg_), PatchItem(id="s1", action="hedge", text="x" * 400), "", ) is None   # edit-size cap
    assert apply_item(dict(seg_), PatchItem(id="s1", action="hedge", text="NIR may work to 0.01 %."), "") is None
    assert apply_item(dict(seg_), PatchItem(id="s1", action="rewrite", text="Something entirely unrelated here."),
                      "NIR spectra in the near infrared") is None
    assert apply_item(dict(seg_), PatchItem(id="s1", action="relabel", claim_type=ClaimType.AFS), "") is None
    assert apply_item(dict(seg_), PatchItem(id="s1", action="hedge", text="NIR may work."), "") == "hedge"


def test_patching_stops_after_two_rounds_and_strips_what_still_fails(kb):
    body = minimal_body(decision_basis=[seg("Fine statement."), seg("It guarantees success.")])
    issues = [Issue(check_id="P-NO-GUARANTEE", path="decision_basis[1]", message="over-claiming wording")]
    stubborn = {"patches": [{"id": "s1", "action": "hedge", "text": "It guarantees success always."}]}
    out, gw = run_patch(kb, body, issues, [stubborn, stubborn, stubborn])
    assert MAX_ROUNDS == 2 and out.rounds == 2 and len(gw.requests) == 2 and out.calls == 2
    assert [s.text for s in out.body.decision_basis] == ["Fine statement."]
    assert out.stripped == ["decision_basis[1]"] and [i for i in out.issues if i.severity == "error"] == []


def test_patcher_omissions_default_to_an_honest_label(kb):
    body = minimal_body(decision_basis=[seg("NIR resolves every analyte.", ClaimType.AFS,
                                            ["S01-p10-nir-range"])])
    issues = [Issue(check_id="C-SUPPORT", path="decision_basis[0]", message="unsupported: not in the quote")]
    out, _ = run_patch(kb, body, issues, [{"patches": []}])
    assert out.body.decision_basis[0].claim_type == ClaimType.ASSUMPTION and out.actions[0]["action"] == "relabel"


# ---------------------------------------------------------------- the whole workflow

def writer_drafts(rationale_cites=("S01-p17-nir-reflection-opaque",)):
    return {AnswerSection: AnswerSection(
        recommendations=[RecProse(rec_id="r1", rationale=[
            seg("NIR reflection probes are used for opaque dairy products according to the source.", ClaimType.AFS,
                list(rationale_cites))],
            limitations=[seg("Overlapping NIR bands mean that quantitative results rely on chemometric calibration.",
                             ClaimType.AFS, ["S01-p10-nir-chemometrics"])])],
        direct_answer=[seg("Start with NIR diffuse reflection on retained samples.", ClaimType.PROPOSAL)],
        verdict="CONDITIONAL")}


def run_workflow(kb, sections=None, gateway=None, flags=None, text=TEXT, sheet=None, **scripted):
    gw = gateway or workflow_fake(sheet or dairy_sheet(), sections=sections, **scripted)
    events = []
    result = Pipeline(gw, kb, MAT, flags or PipelineFlags(), emit=events.append).run(enquiry(text))
    return result, events, gw


def test_event_order_engine_ready_first_run_completed_last(kb):
    result, events, _ = run_workflow(kb, writer_drafts())
    types = [e["type"] for e in events]
    assert types.index("engine_ready") < types.index("section_ready") and types[-1] == "run_completed"
    assert types.count("engine_ready") == 1 and [e["seq"] for e in events] == list(range(len(events)))
    stages = [e["stage"] for e in events if e["type"] == "stage_completed"]
    assert stages == ["scope", "extract", "normalise", "rules", "retrieve", "write", "verify", "render"]
    assert not {"draft", "repair"} & set(stages)
    ready = [e for e in events if e["type"] == "section_ready"]
    assert sorted(e["payload"]["section"] for e in ready) == ["answer", "concept", "plan"]
    assert all(e["stage"] == "write" and e["payload"]["paths"] == SECTION_PATHS[e["payload"]["section"]] for e in ready)
    eng = next(e for e in events if e["type"] == "engine_ready")
    assert eng["stage"] == "rules" and eng["payload"]["status"] == "PROVISIONAL"
    assert eng["payload"]["questions"] == [] and eng["payload"]["spectral_methods"] == ["NIR"]
    cand = eng["payload"]["candidates"][0]
    assert {"method", "technique", "score", "blocked"} <= set(cand) and cand["method"] == "NIR"
    retrieve = next(i for i, e in enumerate(events) if e["type"] == "stage_started" and e["stage"] == "retrieve")
    assert types.index("engine_ready") < retrieve < types.index("section_ready")    # engine first, then evidence, writers
    assert result.report.recommendations[0].rationale[0].text.startswith("NIR reflection probes")


def test_a_failing_sentence_costs_one_patch_call_and_the_report_still_passes(kb):
    drafts = writer_drafts(rationale_cites=())                   # AFS sentence without a card
    result, events, gw = run_workflow(kb, drafts, patcher=[{"patches": [
        {"id": "s1", "action": "relabel", "claim_type": "PROPOSAL"}]}])
    roles = [r["role"] for r in gw.requests]
    assert roles.count("judge") == 1 and roles.count("patcher") == 1 and roles.count("writer") == 3
    assert "patch" in result.manifest.timings and events[-1]["type"] == "run_completed"
    repaired = next(e for e in events if e["type"] == "repaired")
    assert repaired["stage"] == "patch" and repaired["payload"]["remaining"] == []
    assert repaired["payload"]["actions"][0]["action"] == "relabel"
    assert all(result.report.compliance.values()) and result.verification.passed
    # the batch pipeline makes 5 calls without a patch and 6 with one
    assert len(roles) == 6


def test_a_writer_citation_outside_its_slice_is_recorded_and_fixed(kb):
    _, _, pack, _, slices, _ = context(kb)
    outside = next(c.id for c in pack.cards if c.id not in {x.id for x in slices["answer"]})
    drafts = writer_drafts(rationale_cites=(outside,))
    result, events, _ = run_workflow(kb, drafts, patcher=[{"patches": []}])
    warn = [i for i in result.verification.issues if i.severity == "warning" and "outside the evidence" in i.message]
    assert warn and warn[0].path == "recommendations[0].rationale[0]"
    assert any(e["type"] == "issue_found" and "outside the evidence" in e["payload"]["message"] for e in events)
    assert result.report.compliance["C-IDS"] is True


def test_a_writer_that_fails_leaves_its_section_to_code(kb):
    from prism.llm.gateway import LLMUnavailable
    result, _, gw = run_workflow(kb, {ConceptSection: LLMUnavailable("truncated at max_tokens")})
    assert result.report.measurement_concept[0].probe_geometry and result.report.feasibility_plan.steps
    assert any(i.check_id == "W-WRITER" for i in result.verification.issues)
    assert [r["role"] for r in gw.requests].count("writer") == 3


def test_verify_and_repair_flags_switch_the_judge_and_the_patcher_off(kb):
    _, _, gw = run_workflow(kb, flags=PipelineFlags(verify=False))
    assert [r["role"] for r in gw.requests].count("judge") == 0
    _, _, gw = run_workflow(kb, writer_drafts(()), flags=PipelineFlags(repair=False))
    roles = [r["role"] for r in gw.requests]
    assert roles.count("judge") == 1 and roles.count("patcher") == 0


def test_prepare_then_write_equals_the_batch_run(kb):
    batch, _, _ = run_workflow(kb, writer_drafts())
    wf = Workflow(workflow_fake(dairy_sheet(), sections=writer_drafts()), kb, PipelineFlags(), materials=MAT)
    prepared = wf.prepare(enquiry())
    assert prepared.questions == [] and not prepared.refused and prepared.confirmed == {}
    assert prepared.findings.status == DecisionStatus.PROVISIONAL and prepared.preview()["spectral_methods"] == ["NIR"]
    result = wf.write(prepared)
    assert result.markdown == batch.markdown and result.manifest.run_id == batch.manifest.run_id


def test_a_refused_enquiry_prepares_nothing_and_writes_the_refusal(kb):
    wf = Workflow(FakeGateway({}), kb, PipelineFlags(), materials=MAT)
    prepared = wf.prepare(enquiry("Write a poem about autumn leaves."))
    assert prepared.refused and prepared.sheet is None and prepared.questions == []
    result = wf.write(prepared)
    assert result.report is None and "Example:" in result.markdown
    with pytest.raises(ValueError):
        wf.answer(prepared, "distance", "remote")


# ---------------------------------------------------------------- answer(): the engine only

def undefined_workflow(kb):
    sheet = make_sheet(matrix="liquid", targets=("an unknown contaminant",), undefined_targets=True)
    gw = workflow_fake(sheet)
    return Workflow(gw, kb, PipelineFlags(), materials=MAT), gw


def test_answer_makes_no_llm_call_and_follows_the_engine(kb):
    wf, gw = undefined_workflow(kb)
    prepared = wf.prepare(enquiry(UNDEFINED_TEXT))
    assert prepared.findings.status == DecisionStatus.INSUFFICIENT_INFORMATION
    assert [r.role for r in prepared.skeleton.recs] == [RecRole.SCREENING]
    calls = len(gw.requests)
    t0 = time.monotonic()
    after = wf.answer(prepared, "streams.s1.targets", "protein content")
    elapsed = time.monotonic() - t0
    assert len(gw.requests) == calls and elapsed < 0.3                      # zero LLM calls, well under 0.3 s
    assert after.findings.status == DecisionStatus.PROVISIONAL
    assert after.confirmed == {"streams.s1.targets": "protein content"}
    assert after.run_id != prepared.run_id and after.findings.top("s1", 1)
    assert next(r.role for r in after.skeleton.recs) == RecRole.PRIMARY
    target = after.sheet.streams[0].targets[0]
    assert target.name == "protein content" and target.quote == CONFIRMED_QUOTE and target.defined
    assert prepared.sheet.streams[0].targets[0].name == "an unknown contaminant"      # the original is untouched
    # "not known yet" reopens the slot
    back = wf.answer(after, "streams.s1.targets", "unknown")
    assert back.findings.status == DecisionStatus.INSUFFICIENT_INFORMATION and back.confirmed == {}


def test_answer_changes_candidates_for_an_optical_state(kb):
    sheet = make_sheet(matrix="liquid", optics="unknown", domain="dairy_food", targets=("fat",))
    gw = workflow_fake(sheet)
    wf = Workflow(gw, kb, PipelineFlags(), materials=MAT)
    prepared = wf.prepare(enquiry("We need to monitor fat in a liquid dairy stream with a fiber probe. What first?"))
    clear = wf.answer(prepared, "streams.s1.optics", "clear")
    opaque = wf.answer(prepared, "streams.s1.optics", "opaque")
    best = lambda p: p.findings.top("s1", 1)[0].technique_id                          
    assert best(clear) != best(opaque) and "transmission" in best(clear) and "reflection" in best(opaque)
    assert [r["role"] for r in gw.requests] == ["extractor"]       # three engine runs, still no further model call
    with pytest.raises(ValueError):
        wf.answer(prepared, "streams.s1.optics", "foggy")
    with pytest.raises(ValueError):
        wf.answer(prepared, "no_such_slot", "x")


def test_confirmed_facts_are_labelled_and_never_quoted_as_the_client(kb):
    sheet = dairy_sheet(optics="unknown")
    gw = workflow_fake(sheet)
    wf = Workflow(gw, kb, PipelineFlags(), materials=MAT)
    prepared = wf.prepare(enquiry())
    prepared = wf.answer(prepared, "distance", "remote")
    prepared = wf.answer(prepared, "streams.s1.optics", "opaque")
    result = wf.write(prepared)
    facts = {f.slot: f for f in result.report.requirements.stated_facts}
    assert facts["distance"].provenance == "confirmed" and facts["distance"].quote == CONFIRMED_QUOTE
    assert facts["streams.s1.targets"].provenance == "client"
    assert "distance: remote (confirmed in conversation)" in result.markdown
    assert result.report.compliance["P-NO-SELF-ANSWER"] is True
    assert "distance" not in {u.slot for u in result.report.requirements.key_unknowns}
    assert "confirmed in conversation" not in "".join(f"“{f.quote}”" for f in facts.values() if f.provenance == "client")
    assert result.manifest.run_id == prepared.run_id


def test_apply_confirmed_validates_slots_and_values():
    sheet = make_sheet(matrix="liquid")
    assert apply_confirmed(sheet, {"distance": "remote"}).distance == Fact(value="remote", quote=CONFIRMED_QUOTE)
    assert apply_confirmed(sheet, {"distance": "unknown"}).distance.value == "unknown"
    assert apply_confirmed(sheet, {"streams.s1.matrix": "powder"}).streams[0].matrix.confirmed
    with pytest.raises(ValueError):
        apply_confirmed(sheet, {"distance": "on the moon"})
    with pytest.raises(ValueError):
        apply_confirmed(sheet, {"streams.s9.matrix": "powder"})
