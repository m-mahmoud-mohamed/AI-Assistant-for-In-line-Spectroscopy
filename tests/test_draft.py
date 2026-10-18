from prism.assist.sections import (
    SECTIONS,
    AnswerSection,
    ConceptSection,
    PlanSection,
    build_skeleton,
    slice_pack,
)
from prism.cases import sha256_text
from prism.llm.gateway import LLMUnavailable
from prism.rules.engine import evaluate
from prism.schemas import DecisionStatus, Enquiry
from prism.stages.draft import build_section_messages, write_sections
from prism.stages.retrieve import Retriever
from tests.factories import make_sheet
from tests.fakes import FakeGateway, workflow_fake

TEXT = "We need to check an unknown contaminant in a liquid. Which sensor exactly?"


def setup(kb):
    sheet = make_sheet(matrix="liquid", targets=("an unknown contaminant",), undefined_targets=True)
    findings = evaluate(sheet, kb)
    pack = Retriever(kb).pack(sheet, findings)
    skeleton = build_skeleton(sheet, findings, kb)
    slices = slice_pack(pack, skeleton, findings, kb)
    enquiry = Enquiry(case_id="T", title="t", text=TEXT, sha256=sha256_text(TEXT))
    return enquiry, sheet, findings, skeleton, slices


def test_prompt_carries_skeleton_findings_slice_and_exemplars(kb):
    enquiry, sheet, findings, skeleton, slices = setup(kb)
    msgs, phash = build_section_messages("answer", enquiry, sheet, findings, skeleton, slices["answer"],
                                         {"D01": "D01 · example"}, confirmed={"distance": "remote"})
    system, user = msgs[0]["content"], msgs[1]["content"]
    assert "Do not invent" in system and "YOUR SECTION: answer" in system and len(phash) == 12
    assert "R-UNDEFINED-TARGET" in user and "INSUFFICIENT_INFORMATION" in user and "SKELETON" in user
    assert "r1: SCREENING" in user and "<enquiry>" in user and "D01 · example" in user
    assert "distance = remote" in user and "not client words" in user
    for card in slices["answer"]:
        assert f"[{card.id}]" in user
    outside = {c.id for c in slices["concept"]} - {c.id for c in slices["answer"]}
    assert outside and not any(f"[{cid}]" in user for cid in outside)       # a writer sees only its own slice


def test_each_section_has_its_own_instructions(kb):
    enquiry, sheet, findings, skeleton, slices = setup(kb)
    systems = {s: build_section_messages(s, enquiry, sheet, findings, skeleton, slices[s], {})[0][0]["content"]
               for s in SECTIONS}
    assert "direct_answer" in systems["answer"] and "spectral_caveats" in systems["concept"]
    assert "decision_basis" in systems["plan"] and "feasibility" in systems["plan"].lower()


def test_three_writers_run_concurrently_and_report_in_completion_order(kb):
    enquiry, sheet, findings, skeleton, slices = setup(kb)
    gw = workflow_fake()
    seen = []
    drafts, meta = write_sections(enquiry, sheet, findings, skeleton, slices, gw, {}, on_section=lambda s, d: seen.append(s))
    assert sorted(drafts) == sorted(SECTIONS) == sorted(seen)
    assert [r["role"] for r in gw.requests] == ["writer"] * 3 and meta["failed"] == {}
    assert {r["schema"] for r in gw.requests} == {AnswerSection, ConceptSection, PlanSection}


def test_deep_role_is_used_when_requested(kb):
    enquiry, sheet, findings, skeleton, slices = setup(kb)
    gw = workflow_fake()
    write_sections(enquiry, sheet, findings, skeleton, slices, gw, {}, role="writer_deep")
    assert [r["role"] for r in gw.requests] == ["writer_deep"] * 3


def test_a_failed_writer_leaves_its_section_to_code_but_all_failing_raises(kb):
    enquiry, sheet, findings, skeleton, slices = setup(kb)
    gw = workflow_fake(sections={AnswerSection: LLMUnavailable("role 'writer' failed: truncated")})
    drafts, meta = write_sections(enquiry, sheet, findings, skeleton, slices, gw, {})
    assert sorted(drafts) == ["concept", "plan"] and list(meta["failed"]) == ["answer"]
    boom = LLMUnavailable("down")
    gw = FakeGateway(by_schema={AnswerSection: [boom], ConceptSection: [boom], PlanSection: [boom]})
    try:
        write_sections(enquiry, sheet, findings, skeleton, slices, gw, {})
    except LLMUnavailable as exc:
        assert "all section writers failed" in str(exc)
    else:
        raise AssertionError("expected LLMUnavailable")


def test_the_engine_status_is_not_a_writer_field(kb):
    assert "decision_status" not in AnswerSection.model_fields | ConceptSection.model_fields | PlanSection.model_fields
    _, _, findings, skeleton, _ = setup(kb)
    assert skeleton.status == findings.status == DecisionStatus.INSUFFICIENT_INFORMATION


def test_the_three_writers_really_overlap_in_time(kb):
    import threading

    enquiry, sheet, findings, skeleton, slices = setup(kb)
    barrier = threading.Barrier(3, timeout=5)           # every call must be in flight before any can finish

    class Slow(FakeGateway):
        def complete(self, role, messages, schema=None, **kw):
            barrier.wait()
            return super().complete(role, messages, schema, **kw)

    gw = Slow({}, by_schema=workflow_fake().by_schema)
    drafts, _ = write_sections(enquiry, sheet, findings, skeleton, slices, gw, {})
    assert sorted(drafts) == sorted(SECTIONS)


def test_a_profile_can_route_each_section_writer_to_its_own_models():
    from types import SimpleNamespace

    from prism.stages.draft import section_role
    split = SimpleNamespace(profile=SimpleNamespace(roles={"writer": 1, "writer_plan": 2}))
    assert section_role(split, "writer", "plan") == "writer_plan"
    assert section_role(split, "writer", "answer") == "writer"
    assert section_role(split, "writer_deep", "plan") == "writer_deep"          # deep keeps one model for all
    assert section_role(object(), "writer", "plan") == "writer"                 # a gateway without a profile
