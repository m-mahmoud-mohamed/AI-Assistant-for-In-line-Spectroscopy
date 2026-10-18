"""The assistant turn API (CONTRACTS C4): the fast path, question and approval pauses, Stop, the agent loop with its
step cap and answer verifier, SSE resume, partial reports and the /messages compatibility. Fake models only."""
import threading
import time

from prism.assist.harness import DECLINED, LIMIT_NOTE, MAX_STEPS
from prism.assist.turns import STOPPED_MESSAGE
from prism.chat import GUARD_NOTE
from prism.llm.gateway import LLMUnavailable
from tests.factories import make_sheet
from tests.test_api import sse_events, wait_report
from tests.test_harness import OPEN, TEXT, Env, source_ids, summary, types

FOLLOW_UP = "Why is the NIR diffuse reflection probe the first choice here?"


def test_fast_path_streams_plan_verdict_report_summary_and_next_steps(kb, tmp_path):
    with Env(kb, tmp_path, agent=[summary]) as env:
        sid = env.session()
        tid = env.turn(sid, text=TEXT)
        events = env.events(tid)
        assert types(events) == ["plan", "tool_started", "tool_finished", "verdict", "plan", "report", "plan", "plan",
                                 "message_delta", "suggestions", "turn_completed"]
        assert [e["seq"] for e in events] == list(range(len(events)))
        assert all(e["turn_id"] == tid and e["ts"] for e in events)
        plans = [[s["status"] for s in e["payload"]["steps"]] for e in events if e["type"] == "plan"]
        assert plans == [["active", "pending", "pending", "pending"], ["done", "skipped", "active", "pending"],
                         ["done", "skipped", "done", "active"], ["done", "skipped", "done", "done"]]
        started, finished = events[1]["payload"], events[2]["payload"]
        assert started["tool"] == "assess.prepare" and finished["call_id"] == started["call_id"] and finished["ok"]
        verdict = events[3]["payload"]
        assert verdict["status"] == "PROVISIONAL" and verdict["candidates"] and verdict["questions"] == []
        report = next(e for e in events if e["type"] == "report")["payload"]
        assert report["version"] == 1
        run_events = sse_events(env.client, report["run_id"])
        kinds = [e["type"] for e in run_events]
        assert kinds[0] == "stage_started" and kinds[-1] == "run_completed"
        assert kinds.index("engine_ready") < kinds.index("section_ready")
        stored = wait_report(env.client, report["run_id"]).json()
        assert stored["run_id"] == report["run_id"]
        done = events[-1]["payload"]
        cited = list(done["citations"])
        assert cited and set(cited) <= {s["id"] for s in stored["sources"]} and f"[{cited[0]}]" in done["message"]
        assert "3.5" not in done["message"]                     # the verifier dropped the number nobody stated
        assert "".join(e["payload"]["text"] for e in events if e["type"] == "message_delta") == done["message"]
        actions = [o["action"] for o in next(e for e in events if e["type"] == "suggestions")["payload"]["options"]]
        assert actions[:1] == ["draft_email"] and "assess.write_deep" in actions
        # one extraction and three writers in the workflow, one agent call for the summary
        assert sorted(env.roles()) == ["extractor", "writer", "writer", "writer"]
        assert [r["role"] for r in env.chat.requests] == ["agent"] and env.chat.requests[0]["tools"] == []
        session = env.client.get(f"/api/sessions/{sid}").json()
        assert [(m["role"], m["kind"]) for m in session["messages"]] == [("user", "enquiry"), ("assistant", "answer")]
        assert session["messages"][1]["run_id"] == report["run_id"] and session["active_turn_id"] is None
        assert env.client.get(f"/api/turns/{tid}").json()["status"] == "completed"


def test_question_pauses_the_turn_and_answers_drive_the_verdict_and_the_report(kb, tmp_path):
    with Env(kb, tmp_path, sheet=OPEN, agent=[summary]) as env:
        sid = env.session()
        tid = env.turn(sid, text=TEXT)
        question = env.wait(tid, "question")
        payload = question["payload"]
        assert payload["title"].endswith("that change the recommendation") and 1 <= len(payload["questions"]) <= 3
        optics = next(q for q in payload["questions"] if q["id"] == "streams.s1.optics")
        assert {o["value"] for o in optics["options"]} >= {"clear", "opaque"} and all(o["effect"] for o in
                                                                                      optics["options"])
        state = env.client.get(f"/api/turns/{tid}").json()
        assert state["status"] == "waiting" and state["pending"]["question_id"] == payload["question_id"]
        assert env.client.get(f"/api/sessions/{sid}").json()["active_turn_id"] == tid
        first = env.wait(tid, "verdict")["payload"]
        assert env.answer(tid, question, **{"streams.s1.optics": "opaque"}).json() == {"ok": True}
        assert env.answer(tid, question).status_code == 409                  # answered once only
        events = env.events(tid)
        after = types(events)[types(events).index("question") + 1:]
        assert after[:4] == ["tool_started", "tool_finished", "verdict", "plan"] and "report" in after
        assert events[-1]["type"] == "turn_completed"
        second = [e for e in events if e["type"] == "verdict"][1]["payload"]
        assert second["candidates"][0]["technique"] != first["candidates"][0]["technique"]
        assert env.store.assist_state(sid)[0] == {"streams.s1.optics": "opaque"}
        run_id = next(e for e in events if e["type"] == "report")["payload"]["run_id"]
        report = wait_report(env.client, run_id).json()
        facts = {f["slot"]: f for f in report["requirements"]["stated_facts"]}
        assert facts["streams.s1.optics"]["provenance"] == "confirmed"
        engine = next(e for e in sse_events(env.client, run_id) if e["type"] == "engine_ready")
        assert engine["payload"]["candidates"] == second["candidates"]     # the run opens with the answered verdict
        assert "classifier" not in env.roles()                              # clicks cost no model call


def test_a_second_card_asks_only_what_the_first_answers_opened(kb, tmp_path):
    sheet = make_sheet(matrix="unknown", optics="unknown", domain="other", targets=("water content",))
    with Env(kb, tmp_path, sheet=sheet, agent=[summary]) as env:
        sid = env.session()
        tid = env.turn(sid, text=TEXT)
        first = env.wait(tid, "question")
        asked = {q["id"] for q in first["payload"]["questions"]}
        assert asked == {"streams.s1.targets", "streams.s1.matrix", "distance"}
        env.answer(tid, first, **{"streams.s1.targets": "defined", "streams.s1.matrix": "liquid",
                                  "distance": "at_process"})
        second = env.wait(tid, "question", count=2)
        assert second["payload"]["title"].startswith("3 more questions")
        assert not asked & {q["id"] for q in second["payload"]["questions"]}
        env.answer(tid, second)                                              # all "not known yet"
        events = env.events(tid)
        assert types(events).count("question") == 2 and types(events).count("verdict") == 3
        assert events[-1]["type"] == "turn_completed"
        confirmed, deferred = env.store.assist_state(sid)
        assert confirmed == {"streams.s1.targets": "defined", "streams.s1.matrix": "liquid", "distance": "at_process"}
        assert set(deferred) == {q["id"] for q in second["payload"]["questions"]}


def test_stop_ends_a_waiting_turn_at_once(kb, tmp_path):
    with Env(kb, tmp_path, sheet=OPEN) as env:
        sid = env.session()
        tid = env.turn(sid, text=TEXT)
        question = env.wait(tid, "question")
        assert env.client.post(f"/api/turns/{tid}/stop").json() == {"ok": True}
        events = env.events(tid)
        assert types(events)[-3:] == ["question", "plan", "turn_completed"]
        assert events[-1]["payload"] == {"message": STOPPED_MESSAGE, "citations": {}, "stopped": True}
        assert [s["status"] for s in events[-2]["payload"]["steps"]] == ["done", "pending", "pending", "pending"]
        assert env.answer(tid, question).status_code == 409 and "report" not in types(events)
        assert env.client.post(f"/api/turns/{tid}/stop").json() == {"ok": True}       # idempotent
        assert env.client.get(f"/api/turns/{tid}").json()["status"] == "stopped"
        assert env.client.get(f"/api/sessions/{sid}").json()["active_turn_id"] is None
        assert env.chat.requests == []


def test_approval_decline_then_approve_a_deep_rerun(kb, tmp_path):
    with Env(kb, tmp_path, agent=[summary, summary]) as env:
        sid, _ = env.assessed()
        tid = env.turn(sid, action="assess.write_deep")
        approval = env.wait(tid, "approval")["payload"]
        assert approval["action"] == "assess.write_deep" and approval["cost_calls"] and approval["why"]
        assert env.client.post(f"/api/turns/{tid}/approve",
                               json={"approval_id": "nope", "approved": True}).status_code == 409
        env.approve(tid, {"payload": approval}, ok=False)
        events = env.events(tid)
        assert types(events) == ["approval", "message_delta", "turn_completed"]
        assert events[-1]["payload"]["message"] == DECLINED["assess.write_deep"]

        tid = env.turn(sid, action="assess.write_deep")
        env.approve(tid, env.wait(tid, "approval"))
        events = env.events(tid)
        assert types(events) == ["approval", "plan", "report", "plan", "plan", "message_delta", "suggestions",
                                 "turn_completed"]
        assert next(e for e in events if e["type"] == "report")["payload"]["version"] == 2
        assert env.seen[-1] == {"deep": True, "web": False}
        assert "writer_deep" in env.roles() and "assess.write_deep" not in [
            o["action"] for o in next(e for e in events if e["type"] == "suggestions")["payload"]["options"]]
        messages = env.client.get(f"/api/sessions/{sid}").json()["messages"]
        assert [(m["role"], m["text"]) for m in messages if m["role"] == "user"][-2:] == [
            ("user", "Re-run deep"), ("user", "Re-run deep")]


def test_clicked_next_steps_draft_an_email_and_compare(kb, tmp_path):
    email = "Dear [Customer name],\n\n1. What does the liquid look like?\n\nKind regards,\n[Your name]"
    with Env(kb, tmp_path, agent=[summary, "NIR leads; Raman stays a comparison [S01-p10-nir-range]."],
             generator=[email]) as env:
        sid, _ = env.assessed()
        tid = env.turn(sid, action="draft_email")
        events = env.events(tid)
        assert types(events) == ["tool_started", "tool_finished", "message_delta", "turn_completed"]
        assert events[0]["payload"]["tool"] == "draft_email" and events[-1]["payload"]["message"] == email
        tid = env.turn(sid, action="compare", payload={"a": "NIR", "b": "Raman"})
        events = env.events(tid)
        assert events[-1]["type"] == "turn_completed"
        assert env.chat.requests[-1]["messages"][1]["content"].startswith("Compare NIR and Raman for this enquiry")
        users = [m["text"] for m in env.client.get(f"/api/sessions/{sid}").json()["messages"] if m["role"] == "user"]
        assert users[-2:] == ["Draft client e-mail", "Compare NIR vs Raman"]


def test_agent_tools_preview_save_approve_and_reassess_when_the_scientist_asks(kb, tmp_path):
    """A request in question form goes to the agent loop (statements of fact are applied by the harness, see
    test_living_report.py); the agent's own what-if, answer, approval and write tools still work."""
    def final(messages):
        return f"With an opaque product the diffuse reflection probe leads [{source_ids(messages)[0]}]."

    script = [
        [("assess_what_if", {"slot": "streams.s1.optics", "value": "opaque"})],
        [("assess_answer", {"slot": "streams.s1.optics", "value": "opaque"})],
        [("request_approval", {"action": "assess.write", "why": "The optics change the probe geometry."})],
        [("assess_write", {})],
        final,
    ]
    with Env(kb, tmp_path, sheet=OPEN, agent=[summary, *script]) as env:
        sid, _ = env.assessed()
        assert env.store.assist_state(sid)[0] == {}
        tid = env.turn(sid, text="Can you record that the milk is opaque at the probe and re-assess?")
        approval = env.wait(tid, "approval")
        assert approval["payload"]["why"] == "The optics change the probe geometry."
        assert env.store.assist_state(sid)[0] == {"streams.s1.optics": "opaque"}     # saved before the approval
        env.approve(tid, approval)
        events = env.events(tid)
        assert types(events) == ["tool_started", "tool_finished", "tool_started", "verdict", "tool_finished",
                                 "approval", "report", "message_delta", "suggestions", "turn_completed"]
        what_if = events[1]["payload"]
        assert events[0]["payload"]["tool"] == "assess.what_if" and "diffuse reflection" in what_if["summary"]
        assert next(e for e in events if e["type"] == "report")["payload"]["version"] == 2
        assert events[-1]["payload"]["citations"]
        # the result of assess_write reaches the model, and the new report's sources may be cited
        tool_results = [m for m in env.chat.requests[-1]["messages"] if m["role"] == "tool"]
        assert '"version": 2' in tool_results[-1]["content"]
        session = env.client.get(f"/api/sessions/{sid}").json()
        assert [r["version"] for r in session["reports"]] == [1, 2]
        user = [m for m in session["messages"] if m["role"] == "user"][-1]
        assert user["kind"] == "new_client_info" and user["run_id"] == session["reports"][1]["run_id"]
        report = wait_report(env.client, session["reports"][1]["run_id"]).json()
        assert {f["slot"]: f["provenance"] for f in report["requirements"]["stated_facts"]}[
            "streams.s1.optics"] == "confirmed"


def test_agent_asks_with_slot_and_free_questions(kb, tmp_path):
    script = [[("ask_user", {"slots": ["distance"],
                             "questions": [{"text": "Is a bypass loop possible?", "options": ["Yes", "No"]}]})],
              "Thanks; noted."]
    with Env(kb, tmp_path, sheet=OPEN, agent=[summary, *script]) as env:
        sid, _ = env.assessed()
        tid = env.turn(sid, text="Which probe position would you choose?")
        question = env.wait(tid, "question")
        ids = [q["id"] for q in question["payload"]["questions"]]
        assert ids == ["distance", "free-1"] and question["payload"]["questions"][1]["options"][0]["effect"] == ""
        env.answer(tid, question, distance="remote", **{"free-1": "Yes"})
        events = env.events(tid)
        assert types(events) == ["question", "verdict", "message_delta", "suggestions", "turn_completed"]
        result = [m for m in env.chat.requests[-1]["messages"] if m["role"] == "tool"][-1]["content"]
        assert "Far away, long cable run" in result and '"Is a bypass loop possible?": "Yes"' in result
        assert env.store.assist_state(sid)[0] == {"distance": "remote"}


def test_step_cap_forces_an_answer_after_eight_tool_steps(kb, tmp_path):
    script = [[("kb_search", {"query": f"nir {i}"})] for i in range(MAX_STEPS)] + ["The cards above support it."]
    with Env(kb, tmp_path, agent=[summary, *script]) as env:
        sid, _ = env.assessed()
        tid = env.turn(sid, text=FOLLOW_UP)
        events = env.events(tid)
        assert types(events).count("tool_started") == MAX_STEPS
        assert env.chat.requests[-1]["messages"][-1] == {"role": "user", "content": LIMIT_NOTE}
        assert events[-1]["payload"]["message"] == "The cards above support it."
        assert len(env.chat.requests) == 1 + MAX_STEPS + 1


def test_verifier_strips_an_uncited_number_and_unknown_cards(kb, tmp_path):
    script = [[("kb_card", {"card_id": "S01-p09-mir-range"})],
              ("MIR covers 2.5–25 µm [S01-p09-mir-range]. The probe reaches 0.37 % accuracy in your process "
               "[S99-p01-made-up].")]
    with Env(kb, tmp_path, agent=[summary, *script]) as env:
        sid, _ = env.assessed()
        tid = env.turn(sid, text="What range does MIR cover?")
        done = env.events(tid)[-1]["payload"]
        assert "0.37" not in done["message"] and "S99" not in done["message"] and GUARD_NOTE in done["message"]
        assert done["message"].startswith("MIR covers 2.5–25 µm [S01-p09-mir-range].")
        assert done["citations"] == {"S01-p09-mir-range": "S01 p.9"}
        tools = env.chat.requests[-1]["tools"]
        assert {"ask_user", "update_plan", "request_approval", "suggest_next", "assess_what_if", "assess_write",
                "kb_search", "calc_atr_depth", "draft_email"} <= set(tools)


def test_off_topic_follow_up_is_refused_without_a_model_call(kb, tmp_path):
    with Env(kb, tmp_path, agent=[summary]) as env:
        sid, _ = env.assessed()
        tid = env.turn(sid, text="Write a poem about autumn leaves.")
        events = env.events(tid)
        assert types(events) == ["message_delta", "turn_completed"]
        assert "not about a process or material measurement" in events[-1]["payload"]["message"]
        assert len(env.chat.requests) == 1                                  # the first turn's summary only
        assert env.client.get(f"/api/sessions/{sid}").json()["messages"][-1]["kind"] == "refused"


def test_sse_resumes_after_last_event_id(kb, tmp_path):
    with Env(kb, tmp_path, agent=[summary]) as env:
        sid = env.session()
        tid = env.turn(sid, text=TEXT)
        events = env.events(tid)
        resumed = env.events(tid, last_id=3)
        assert [e["seq"] for e in resumed] == [e["seq"] for e in events[4:]]
        assert env.events(tid, last_id=events[-1]["seq"]) == []
        with env.client.stream("GET", f"/api/turns/{tid}/events") as r:
            frames = "".join(r.iter_text())
        assert "id: 0" in frames and f"id: {events[-1]['seq']}" in frames


def test_partial_report_while_the_run_writes(kb, tmp_path):
    gate = threading.Event()
    with Env(kb, tmp_path, gate=gate) as env:
        sid = env.session()
        run_id = env.client.post(f"/api/sessions/{sid}/runs", json={}).json()["run_id"]
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            ready = {e["payload"]["section"] for e in env.store.events(run_id) if e["type"] == "section_ready"}
            if {"answer", "concept"} <= ready:
                break
            time.sleep(0.02)
        partial = env.client.get(f"/api/runs/{run_id}/report")
        assert partial.status_code == 200
        body = partial.json()
        assert body["run_id"] == run_id
        assert body["partial"] is True and set(body["sections"]) == {"answer", "concept"}
        assert body["direct_answer"]["text"] and body["recommendations"] and "feasibility_plan" not in body
        assert body["findings"]["candidates"] and body["requirements"]["stated_facts"] and body["sources"]
        gate.set()
        assert sse_events(env.client, run_id)[-1]["type"] == "run_completed"
        final = env.client.get(f"/api/runs/{run_id}/report").json()
        assert "partial" not in final and final["feasibility_plan"]["steps"]


def test_messages_endpoint_runs_as_a_turn_and_keeps_its_shape(kb, tmp_path):
    with Env(kb, tmp_path, agent=[summary, "The nominal NIR range is 780–2500 nm [S01-p10-nir-range]."],
             classifier=[{"kind": "QUESTION_ABOUT_REPORT"}]) as env:
        sid, _ = env.assessed()
        r = env.client.post(f"/api/sessions/{sid}/messages", json={"text": FOLLOW_UP}).json()
        assert r.keys() == {"kind", "text", "cited_ids", "tool_calls", "proposed_facts"} and r["kind"] == "answer"
        assert r["cited_ids"] == ["S01-p10-nir-range"]
        with env.store._db() as db:
            turn_id = db.execute("SELECT id FROM turns WHERE kind = 'message'").fetchone()[0]
        events = env.store.turn_events(turn_id)
        assert [e["type"] for e in events] == ["tool_started", "tool_finished", "turn_completed"]
        assert events[-1]["payload"]["citations"] == {"S01-p10-nir-range": "S01 p.10"}


def test_a_model_outage_falls_back_to_a_code_summary_then_fails_a_follow_up(kb, tmp_path):
    down = LLMUnavailable("role 'agent' failed: every model is down")
    with Env(kb, tmp_path, agent=[down, down]) as env:
        sid, events = env.assessed()
        done = events[-1]["payload"]
        assert done["message"].startswith("**Provisional: NIR diffuse reflection probe.**") and done["citations"]
        tid = env.turn(sid, text=FOLLOW_UP)
        events = env.events(tid)
        assert events[-1]["type"] == "turn_failed" and "every model is down" in events[-1]["payload"]["error"]
        assert env.client.get(f"/api/turns/{tid}").json()["status"] == "failed"


def test_turn_api_errors(kb, tmp_path):
    with Env(kb, tmp_path) as env:
        sid = env.session()
        assert env.client.post("/api/sessions/nope/turns", json={"text": "x"}).status_code == 404
        assert env.client.post(f"/api/sessions/{sid}/turns", json={}).status_code == 422
        assert env.client.post(f"/api/sessions/{sid}/turns", json={"action": "launch"}).status_code == 422
        assert env.client.get("/api/turns/nope/events").status_code == 404
        assert env.client.post("/api/turns/nope/stop").status_code == 404
        assert env.client.post("/api/turns/nope/answer", json={"question_id": "q", "answers": {}}).status_code == 404


def test_events_match_the_frontend_demo_payload_types(kb, tmp_path):
    fields = {
        "plan": {"steps": list}, "tool_started": {"call_id": str, "tool": str, "label": str},
        "tool_finished": {"call_id": str, "tool": str, "summary": str, "ms": int, "ok": bool},
        "verdict": {"status": str, "candidates": list, "questions": list},
        "report": {"run_id": str, "version": int}, "message_delta": {"text": str},
        "suggestions": {"options": list}, "turn_completed": {"message": str, "citations": dict},
    }
    with Env(kb, tmp_path, agent=[summary]) as env:
        _, events = env.assessed()
        for event in events:
            assert set(event) == {"type", "turn_id", "seq", "ts", "payload"}
            assert isinstance(event["seq"], int) and isinstance(event["ts"], float)
            for key, kind in fields[event["type"]].items():
                assert isinstance(event["payload"][key], kind), event
            if event["type"] == "plan":
                for step in event["payload"]["steps"]:
                    assert isinstance(step["id"], str) and isinstance(step["label"], str)
                    assert step["status"] in {"pending", "active", "done", "skipped"}
            if event["type"] == "verdict":
                for candidate in event["payload"]["candidates"]:
                    assert isinstance(candidate["method"], str) and isinstance(candidate["technique"], str)
                    assert isinstance(candidate["score"], (int, float)) and isinstance(candidate["blocked"], bool)
            if event["type"] == "turn_completed":
                assert all(isinstance(k, str) and isinstance(v, str) for k, v in event["payload"]["citations"].items())


def test_agent_question_rounds_are_capped_even_with_batched_calls(kb, tmp_path):
    calls = [("ask_user", {"questions": [{"text": text, "options": ["Yes", "No"]}]})
             for text in ("Can we use a bypass?", "Can we obtain samples?", "Can we contact the laboratory?")]
    with Env(kb, tmp_path, agent=[summary, calls, "Thanks; noted."]) as env:
        sid, _ = env.assessed()
        tid = env.turn(sid, text="Which probe position should we test?")
        env.answer(tid, env.wait(tid, "question"))
        env.answer(tid, env.wait(tid, "question", count=2))
        events = env.events(tid)
        assert types(events).count("question") == 2 and events[-1]["type"] == "turn_completed"
        result = [m for m in env.chat.requests[-1]["messages"] if m["role"] == "tool"][-1]
        assert "question limit reached" in result["content"]


def test_tool_call_resend_preserves_gemini_thought_signatures(kb, tmp_path):
    from prism.llm.adapters.base import ToolCall
    from prism.llm.gateway import LLMResult

    call = ToolCall("gemini-call", "kb_card", '{"card_id":"S01-p10-nir-range"}',
                    extra_content={"google": {"thought_signature": "test-signature"}})
    response = LLMResult("", "fake", tool_calls=[call])
    with Env(kb, tmp_path, agent=[summary, response, "Read the card."]) as env:
        sid, _ = env.assessed()
        tid = env.turn(sid, text=FOLLOW_UP)
        assert env.events(tid)[-1]["type"] == "turn_completed"
        resent = [m for m in env.chat.requests[-1]["messages"] if m["role"] == "assistant"][-1]
        assert resent["tool_calls"] == [call.to_message()]


def test_stop_prevents_the_next_tool_in_the_same_model_response(kb, tmp_path, monkeypatch):
    from dataclasses import replace

    from prism.assist import harness

    entered, release = threading.Event(), threading.Event()
    executed = []
    original = harness.domain_tools

    def domain(*args):
        tools = original(*args)
        card = next(t for t in tools if t.name == "kb.card")

        def read(a):
            executed.append(a["card_id"])
            entered.set()
            assert release.wait(5)
            return card.fn(a)

        return [replace(t, fn=read) if t.name == "kb.card" else t for t in tools]

    monkeypatch.setattr(harness, "domain_tools", domain)
    calls = [("kb_card", {"card_id": cid}) for cid in ("S01-p10-nir-range", "S01-p09-mir-range")]
    with Env(kb, tmp_path, agent=[summary, calls]) as env:
        sid, _ = env.assessed()
        tid = env.turn(sid, text=FOLLOW_UP)
        try:
            assert entered.wait(5)
            env.client.post(f"/api/turns/{tid}/stop")
            before = env.events(tid)
        finally:
            release.set()
        deadline = time.monotonic() + 5
        while any(t.name == f"turn-{tid}" for t in threading.enumerate()) and time.monotonic() < deadline:
            time.sleep(0.01)
        assert executed == ["S01-p10-nir-range"]
        assert env.store.turn_events(tid) == before and before[-1]["payload"]["stopped"]
        assert len(env.chat.requests) == 2


def test_stop_report_run_skips_later_workflow_stages(kb, tmp_path):
    gate = threading.Event()
    with Env(kb, tmp_path, gate=gate) as env:
        sid = env.session()
        tid = env.turn(sid, text=TEXT)
        run_id = env.wait(tid, "report")["payload"]["run_id"]
        deadline = time.monotonic() + 5
        while not any(e["type"] == "section_ready" for e in env.store.events(run_id)):
            assert time.monotonic() < deadline
            time.sleep(0.01)
        env.client.post(f"/api/turns/{tid}/stop")
        gate.set()
        events = sse_events(env.client, run_id)
        assert events[-1]["type"] == "run_failed" and "Stopped" in events[-1]["payload"]["error"]
        assert not any(e["stage"] in ("verify", "patch", "render") for e in events)
        assert env.events(tid)[-1]["payload"]["stopped"] and env.chat.requests == []


def test_new_enquiry_uses_fast_path_without_previous_client_facts(kb, tmp_path):
    with Env(kb, tmp_path, agent=[summary, summary]) as env:
        sid, _ = env.assessed()
        env.store.set_chat_state(sid, ["Previous client needs 30 m of fiber."], ["focus on Raman"])
        env.store.set_assist_state(sid, {"distance": "remote"}, ["streams.s1.optics"])
        text = "New enquiry: monitor fat and protein in an opaque liquid dairy stream with a fiber probe."
        tid = env.turn(sid, text=text)
        events = env.events(tid)
        assert events[0]["type"] == "plan" and events[1]["payload"]["tool"] == "assess.prepare"
        assert next(e for e in events if e["type"] == "report")["payload"]["version"] == 2
        assert env.store.enquiry_text(sid) == text and env.store.chat_state(sid) == ([], [])
        assert env.store.assist_state(sid) == ({}, [])
        assert len(env.chat.requests) == 2 and all(not r["tools"] for r in env.chat.requests)
        assert "Previous client" not in env.pipelines[-1].requests[0]["messages"][-1]["content"]


def test_health_hides_legacy_role_aliases(kb, tmp_path):
    from prism.api import _routing
    from prism.llm.profiles import LEGACY_ROLES, load_profile
    from tests.test_harness import ROOT

    with Env(kb, tmp_path) as env:
        env.chat.profile = load_profile(ROOT / "config" / "llm.yaml")
        routing = env.client.get("/api/health").json()["routing"]
        assert "agent" in routing and not set(LEGACY_ROLES) & routing.keys()
        assert routing == _routing(env.chat)


def test_literature_suggestion_waits_for_approval_and_verifies_without_a_report_rerun(kb, tmp_path):
    from tests.test_web_pipeline import QUOTE_GOOD, URL_GOOD, internet
    from tests.web_fakes import make_service

    net = internet()
    web = make_service(tmp_path, net)
    script = [[("web_search", {"query": "in-line NIR probe"})],
              [("web_verify", {"url": URL_GOOD, "quote": QUOTE_GOOD})],
              f"A flush-mounted NIR probe is described (external, doi.org, {URL_GOOD})."]
    with Env(kb, tmp_path, agent=[summary, *script], web=web) as env:
        sid, _ = env.assessed()
        tid = env.turn(sid, action="web.search")
        approval = env.wait(tid, "approval")
        assert net.calls == [] and len(env.chat.requests) == 1
        env.approve(tid, approval, ok=False)
        assert types(env.events(tid)) == ["approval", "message_delta", "turn_completed"]
        assert net.calls == [] and len(env.chat.requests) == 1

        tid = env.turn(sid, action="web.search")
        env.approve(tid, env.wait(tid, "approval"))
        events = env.events(tid)
        assert types(events) == ["approval", "tool_started", "tool_finished", "tool_started", "tool_finished",
                                 "message_delta", "turn_completed"]
        assert [e["payload"]["tool"] for e in events if e["type"] == "tool_started"] == ["web.search", "web.verify"]
        assert net.calls and URL_GOOD in events[-1]["payload"]["message"]
        assert events[-1]["payload"]["web_sources"][0]["quote"] == QUOTE_GOOD
        assert len(env.client.get(f"/api/sessions/{sid}").json()["reports"]) == 1
        assert len(env.chat.requests) == 4


def test_agent_can_route_an_implicit_new_enquiry_into_the_fast_path(kb, tmp_path):
    text = "We have another client who needs to monitor fat and protein in an opaque liquid with a fiber probe."
    with Env(kb, tmp_path, agent=[summary, [("assess_prepare", {"enquiry": text})], summary]) as env:
        sid, _ = env.assessed()
        tid = env.turn(sid, text=text)
        events = env.events(tid)
        assert types(events) == ["plan", "tool_started", "tool_finished", "verdict", "plan", "report", "plan", "plan",
                                 "message_delta", "suggestions", "turn_completed"]
        assert next(e for e in events if e["type"] == "report")["payload"]["version"] == 2
        assert env.store.enquiry_text(sid) == text
        assert len(env.chat.requests) == 3 and env.chat.requests[1]["tools"] and not env.chat.requests[2]["tools"]


def test_step_cap_also_limits_a_single_batch_of_tool_calls(kb, tmp_path):
    calls = [("kb_card", {"card_id": "S01-p10-nir-range"})] * (MAX_STEPS + 2)
    with Env(kb, tmp_path, agent=[summary, calls, "Read the source."]) as env:
        sid, _ = env.assessed()
        events = env.events(env.turn(sid, text=FOLLOW_UP))
        assert types(events).count("tool_started") == MAX_STEPS
        assert env.chat.requests[-1]["tools"] == []
        results = [m for m in env.chat.requests[-1]["messages"] if m["role"] == "tool"]
        assert len(results) == MAX_STEPS + 2 and all("tool limit reached" in r["content"] for r in results[-2:])


def test_turn_events_survive_restart_and_an_abandoned_card_ends_cleanly(kb, tmp_path):
    from fastapi.testclient import TestClient

    from prism.api import RESTARTED, create_app

    with Env(kb, tmp_path) as env:
        sid = env.session()
        tid = env.store.create_turn(sid, "text", {"text": TEXT})
        payload = {"question_id": "persisted-q", "title": "A question", "questions": []}
        env.store.set_turn_status(tid, "waiting", pending={"type": "question", **payload})
        env.store.add_turn_event(tid, {"type": "question", "ts": time.time(), "payload": payload})
        restarted = create_app(env.factory, env.store, kb, gateway=env.chat)
        with TestClient(restarted) as client:
            response = client.get(f"/api/turns/{tid}/events", headers={"Last-Event-ID": "0"})
            assert '"type": "turn_failed"' in response.text and RESTARTED in response.text
            state = client.get(f"/api/turns/{tid}").json()
            assert state["status"] == "failed" and state["pending"] is None
            assert client.post(f"/api/turns/{tid}/answer", json={"question_id": "persisted-q",
                                                                   "answers": {}}).status_code == 409
        assert env.store.turn_events(tid)[0]["payload"] == payload
