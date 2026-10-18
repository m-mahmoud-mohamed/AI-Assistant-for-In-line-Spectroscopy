"""Living reports: a follow-up that adds information revises the affected report sections (a new version), a question
never does, a major change waits for approval; follow-up answers keep supported deductions and drop invented content.
Fake models only."""
from dataclasses import replace

import pytest

from prism.assist.harness import DECLINED, GUARD_NOTE, verify_answer
from prism.assist.revision import impact, triage
from prism.assist.sections import AnswerSection, ConceptSection, PlanSection
from prism.assist.workflow import Workflow
from prism.chat import diff
from prism.schemas import ClaimVerdict
from tests.fakes import workflow_fake
from tests.test_api import wait_report
from tests.test_harness import OPEN, Env, summary
from tests.test_workflow import MAT, dairy_sheet, enquiry

LEAKAGE_FACT = "We have 240 physical samples, each measured at three temperatures."
LEAKAGE_QUESTION = "Is a random spectrum-level train/test split a data-leakage risk?"
LEAKAGE_ANSWER = (
    "You supplied 240 physical samples, each measured at three temperatures. Deduction from your data: "
    "240 × 3 = 720 spectra. General scientific knowledge: with a random spectrum-level split the spectra of one "
    "physical sample land in both the training and the test set, so the test error is optimistic. Split by physical "
    "sample, so that all 3 spectra of a sample stay together.")


def reports(env, sid) -> list[dict]:
    """The stored reports of a session, oldest first, as the API serves them (with their version info)."""
    return [wait_report(env.client, r["run_id"]).json()
            for r in env.client.get(f"/api/sessions/{sid}").json()["reports"]]


def writers(gateway) -> list[type]:
    return [r["schema"] for r in gateway.requests if r.get("schema") in (AnswerSection, ConceptSection, PlanSection)]


# ---------------------------------------------------------------- what a message is

@pytest.mark.parametrize("text, kind", [
    ("We have 240 physical samples available for the feasibility experiment.", "fact"),
    ("The product is opaque at the probe.", "fact"),
    ("Actually, the milk is homogenised and runs at 40 °C.", "fact"),
    ("Please focus on the NIR probe options.", "instruction"),
    ("Can you make the plan shorter?", "instruction"),
    ("Is a random spectrum-level split a leakage risk?", "question"),
    ("What if the product were turbid?", "question"),
    ("Why is NIR the primary method here?", "question"),
    (LEAKAGE_FACT + " " + LEAKAGE_QUESTION, "mixed"),
    ("Thanks", "unclear"),
])
def test_triage_sorts_follow_ups_in_code(text, kind):
    assert triage(text).kind == kind


def test_a_hypothetical_is_never_a_fact():
    t = triage("Suppose the stream is opaque. What would change?")
    assert not t.facts and t.questions


def test_mixed_message_splits_the_fact_from_the_question():
    t = triage(LEAKAGE_FACT + " " + LEAKAGE_QUESTION)
    assert t.facts == (LEAKAGE_FACT,) and t.questions == (LEAKAGE_QUESTION,)


# ---------------------------------------------------------------- new facts revise the report

def test_minor_fact_revises_only_the_affected_sections_automatically(kb, tmp_path):
    fact = "We have 240 physical samples available for the feasibility experiment."
    with Env(kb, tmp_path, agent=[summary, summary]) as env:
        sid, _ = env.assessed()
        tid = env.turn(sid, text=fact)
        events = env.events(tid)
        assert not any(e["type"] == "approval" for e in events)
        assert events[-1]["type"] == "turn_completed"
        report_event = next(e for e in events if e["type"] == "report")["payload"]
        assert report_event["version"] == 2
        v1, v2 = reports(env, sid)
        # only the plan section was written again; the other sections are v1's verified content
        assert writers(env.pipelines[-1]) == [PlanSection]
        for field in ("direct_answer", "recommendations", "premise_checks", "measurement_concept", "risks",
                      "spectral_ranges", "assumptions"):
            assert v2[field] == v1[field], field
        info = v2["version_info"]
        assert info["version"] == 2 and info["trigger"] == fact and info["follow_up_findings"] == [fact]
        assert info["changed_sections"] == ["plan", "requirements"] and "Updated" in info["summary"]
        assert v1["version_info"]["summary"] == "Initial assessment."
        assert v1["original_enquiry"] == v2["original_enquiry"] and v2["original_enquiry"]
        assert env.store.chat_state(sid)[0] == [fact]
        # the sections a revision keeps are announced before the rewritten one
        ready = [e["payload"]["section"] for e in env.store.events(report_event["run_id"]) if e["type"] == "section_ready"]
        assert ready[:2] == ["answer", "concept"] and ready[-1] == "plan"
        # the session knows what triggered each version
        session = env.client.get(f"/api/sessions/{sid}").json()
        assert [r["version"] for r in session["reports"]] == [1, 2] and session["reports"][1]["trigger"] == fact
        assert session["reports"][1]["changed_sections"] == ["plan", "requirements"]
        user = [m for m in session["messages"] if m["role"] == "user"][-1]
        assert user["kind"] == "new_client_info" and user["run_id"] == report_event["run_id"]


def test_question_never_creates_a_version(kb, tmp_path):
    with Env(kb, tmp_path, agent=[summary, "General scientific knowledge: split by physical sample."]) as env:
        sid, _ = env.assessed()
        env.events(env.turn(sid, text=LEAKAGE_QUESTION))
        assert len(env.store.get_session(sid)["reports"]) == 1
        assert env.store.chat_state(sid) == ([], [])


def test_hypothetical_is_neither_recorded_nor_revised(kb, tmp_path):
    with Env(kb, tmp_path, agent=[summary, "If the product were turbid, the geometries would be compared."]) as env:
        sid, _ = env.assessed()
        events = env.events(env.turn(sid, text="What if the product were turbid?"))
        assert events[-1]["type"] == "turn_completed" and not any(e["type"] == "report" for e in events)
        assert len(env.store.get_session(sid)["reports"]) == 1 and env.store.chat_state(sid) == ([], [])


def test_unclear_message_costs_one_classifier_call_and_does_not_revise(kb, tmp_path):
    with Env(kb, tmp_path, agent=[summary, "You are welcome."], classifier=[{"kind": "QUESTION_ABOUT_REPORT"}]) as env:
        sid, _ = env.assessed()
        env.events(env.turn(sid, text="Thanks"))
        assert [r["role"] for r in env.chat.requests].count("classifier") == 1
        assert len(env.store.get_session(sid)["reports"]) == 1


def test_instruction_revises_the_answer_section_and_is_kept_as_a_preference(kb, tmp_path):
    text = "Please focus on the NIR diffuse reflection probe."
    with Env(kb, tmp_path, agent=[summary, summary]) as env:
        sid, _ = env.assessed()
        env.events(env.turn(sid, text=text))
        assert env.store.chat_state(sid) == ([], [text])
        v1, v2 = reports(env, sid)
        assert AnswerSection in writers(env.pipelines[-1]) and PlanSection not in writers(env.pipelines[-1])
        assert "answer" in v2["version_info"]["changed_sections"]
        assert v2["feasibility_plan"] == v1["feasibility_plan"]


def test_major_change_waits_for_approval_then_revises(kb, tmp_path):
    with Env(kb, tmp_path, sheet=OPEN, agent=[summary, summary]) as env:
        sid, _ = env.assessed()
        tid = env.turn(sid, text="The client says the milk is opaque at the probe.")
        approval = env.wait(tid, "approval")
        assert approval["payload"]["label"].startswith("Update the assessment?")
        assert "Primary method" in approval["payload"]["why"] and "→" in approval["payload"]["why"]
        assert len(env.store.get_session(sid)["reports"]) == 1          # nothing is written before the answer
        assert env.store.assist_state(sid)[0] == {"streams.s1.optics": "opaque"}   # but the fact is saved
        env.approve(tid, approval)
        events = env.events(tid)
        assert next(e for e in events if e["type"] == "report")["payload"]["version"] == 2
        _, v2 = reports(env, sid)
        assert v2["version_info"]["changed_sections"] == ["answer", "concept", "plan", "requirements"]
        assert "→" in v2["version_info"]["summary"]
        d = env.client.get(f"/api/sessions/{sid}/diff").json()
        assert d["from"] == 1 and d["to"] == 2
        assert d["recommendations"]["added"] or d["recommendations"]["removed"] or d["recommendations"]["changed"]
        assert "recommendations" in {s["field"] for s in d["sections"]}
        assert all({"field", "label", "added", "removed"} <= set(s) for s in d["sections"])


def test_declining_a_major_change_keeps_the_current_version(kb, tmp_path):
    with Env(kb, tmp_path, sheet=OPEN, agent=[summary]) as env:
        sid, _ = env.assessed()
        tid = env.turn(sid, text="The client says the milk is opaque at the probe.")
        env.approve(tid, env.wait(tid, "approval"), ok=False)
        events = env.events(tid)
        assert events[-1]["payload"]["message"] == DECLINED["assess.write"]
        assert not any(e["type"] == "report" for e in events)
        assert len(env.store.get_session(sid)["reports"]) == 1
        options = next(e for e in events if e["type"] == "suggestions")["payload"]["options"]
        assert options[0]["action"] == "assess.write"
        assert env.store.assist_state(sid)[0] == {"streams.s1.optics": "opaque"}


def test_exports_use_the_version_the_user_is_looking_at(kb, tmp_path):
    fact = "We have 240 physical samples available for the feasibility experiment."
    with Env(kb, tmp_path, agent=[summary, summary]) as env:
        sid, _ = env.assessed()
        env.events(env.turn(sid, text=fact))
        r1, r2 = (r["run_id"] for r in env.client.get(f"/api/sessions/{sid}").json()["reports"])
        md1 = env.client.get(f"/api/runs/{r1}/report.md").text
        md2 = env.client.get(f"/api/runs/{r2}/report.md").text
        assert "Report v1" in md1 and "Changes in this version" not in md1
        assert "Report v2" in md2 and "Changes in this version" in md2 and fact in md2
        assert env.client.get(f"/api/runs/{r2}/report.md", params={"version": 1}).text == md1
        assert env.client.get(f"/api/runs/{r1}/report.md", params={"version": 9}).status_code == 404


# ---------------------------------------------------------------- the workflow keeps what it does not rewrite

def test_partial_revision_keeps_other_verified_sections_and_their_verdicts(kb):
    gw = workflow_fake(dairy_sheet(), n=2)
    wf = Workflow(gw, kb, materials=MAT)
    p = wf.prepare(enquiry())
    first = wf.write(p)
    gw.requests.clear()
    verdict = ClaimVerdict(path="recommendations[0].rationale[0]", verdict="partial", reason="partly")
    p = replace(p, previous_report=first.report, revised_sections=("plan",), revision_trigger="240 samples",
                chat_facts=["We have 240 physical samples."], previous_verdicts=[verdict])
    second = wf.write(p)
    assert writers(gw) == [PlanSection]
    assert second.report.direct_answer == first.report.direct_answer
    assert second.report.measurement_concept == first.report.measurement_concept
    assert second.report.recommendations == first.report.recommendations
    assert second.revision["changed_sections"] == ["plan", "requirements"]
    assert [v.path for v in second.verification.verdicts] == [verdict.path]
    assert diff(first.report, second.report)["status"] is None


def test_impact_is_major_only_when_status_or_primary_changes(kb):
    wf = Workflow(workflow_fake(OPEN, n=2), kb, materials=MAT)
    before = wf.prepare(enquiry())
    after = wf.answer(before, "streams.s1.optics", "opaque")
    major = impact(before.skeleton, after.skeleton, "The product is opaque.")
    assert major.major and "→" in major.summary and major.sections == ("answer", "concept", "plan")
    same = impact(before.skeleton, before.skeleton, "We have 240 physical samples.")
    assert not same.major and same.sections == ("plan",)
    assert impact(before.skeleton, before.skeleton, "The probe sits at 40 °C.").sections == ("concept",)


# ---------------------------------------------------------------- follow-up reasoning without needless refusals

def test_leakage_question_is_answered_with_its_deduction(kb, tmp_path):
    with Env(kb, tmp_path, agent=[summary, LEAKAGE_ANSWER]) as env:
        sid, _ = env.assessed()
        tid = env.turn(sid, text=LEAKAGE_FACT + " " + LEAKAGE_QUESTION)
        done = env.events(tid)[-1]["payload"]
        assert GUARD_NOTE not in done["message"]
        assert "240 × 3 = 720" in done["message"] and "Split by physical sample" in done["message"]
        assert "General scientific knowledge" in done["message"] and "Deduction from your data" in done["message"]
        # the fact in the same message was also applied: the plan has a new version, the answer comes after it
        assert len(env.store.get_session(sid)["reports"]) == 2
        assert "Report v2 was just written" in env.chat.requests[-1]["messages"][0]["content"]


def test_leakage_question_with_its_numbers_inside_is_not_refused(kb, tmp_path):
    question = ("Our spectra come from 240 physical samples, each measured at three temperatures. Is a random "
                "spectrum-level train/test split a data-leakage risk?")
    with Env(kb, tmp_path, agent=[summary, LEAKAGE_ANSWER]) as env:
        sid, _ = env.assessed()
        done = env.events(env.turn(sid, text=question))[-1]["payload"]
        assert "720" in done["message"] and GUARD_NOTE not in done["message"]


def test_supported_numbers_and_arithmetic_pass_the_verifier(kb):
    sources = [LEAKAGE_FACT]
    kept, removed = verify_answer(LEAKAGE_ANSWER, kb, set(), sources)
    assert removed == 0 and "720" in kept and "optimistic" in kept
    # 720 without the equation still follows from the user's own count and repetition
    assert verify_answer("That makes 720 spectra in total.", kb, set(), sources)[1] == 0


def test_an_invented_number_and_a_fake_card_are_still_removed(kb):
    sources = [LEAKAGE_FACT]
    text = ("Deduction from your data: 240 × 3 = 720 spectra. A PLS model reaches 93 % accuracy here. "
            "Split by sample [S99-p01-made-up].")
    kept, removed = verify_answer(text, kb, set(), sources)
    assert removed == 1 and "93" not in kept and "S99" not in kept and "720" in kept
    # an equation whose result is wrong does not make the result a supported number
    assert verify_answer("Deduction: 240 × 3 = 800 spectra.", kb, set(), sources)[0] == ""
    # an operand nobody supplied does not either
    assert verify_answer("Deduction: 37 × 3 = 111 spectra.", kb, set(), sources)[0] == ""


def test_an_off_topic_message_is_still_refused(kb, tmp_path):
    with Env(kb, tmp_path, agent=[summary]) as env:
        sid, _ = env.assessed()
        events = env.events(env.turn(sid, text="Write a poem about autumn leaves."))
        assert events[-1]["type"] == "turn_completed" and len(env.chat.requests) == 1
        assert "not about a process or material measurement" in events[-1]["payload"]["message"]


def test_the_system_prompt_separates_sources_user_facts_deductions_and_general_knowledge(kb, tmp_path):
    with Env(kb, tmp_path, agent=[summary, "Noted."]) as env:
        sid, _ = env.assessed()
        env.events(env.turn(sid, text="Why is NIR the primary method?"))
        system = env.chat.requests[-1]["messages"][0]["content"].lower()
        for phrase in ("you supplied", "deduction from your data", "general scientific knowledge", "open:",
                       "240 × 3 = 720", "never invent a citation"):
            assert phrase in system, phrase
