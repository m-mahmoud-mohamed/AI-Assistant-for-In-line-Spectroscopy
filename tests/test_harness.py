"""The assistant harness: calculators, the answer verifier, turn primitives, answers to question cards, and the test
kit the turn API tests share (a FakeGateway that scripts the agent's function calls). No network."""
import json
import threading
import time
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from prism.api import create_app
from prism.assist import harness
from prism.assist.harness import apply_answers, code_summary, run_seed, verify_answer
from prism.assist.tools import (
    SessionView,
    atr_depth,
    convert,
    domain_tools,
    explain,
    fiber_window,
    loss_budget,
    raman_absolute,
)
from prism.assist.turns import STOPPED_MESSAGE, Stopped, Turn
from prism.assist.workflow import Workflow
from prism.cases import sha256_text
from prism.llm.adapters.base import ToolCall
from prism.llm.gateway import LLMResult
from prism.orchestrator import Pipeline, PipelineFlags
from prism.schemas import Enquiry
from prism.stages.retrieve import Retriever
from prism.store import Store
from tests.factories import make_sheet
from tests.fakes import FakeGateway, workflow_fake

ROOT = Path(__file__).resolve().parents[1]
MAT = ROOT / "materials"
TEXT = ("We need to monitor fat and protein in an opaque liquid dairy stream with a fiber probe. "
        "What should we test first?")
SETTLED = make_sheet(matrix="liquid", optics="opaque", domain="dairy_food", targets=("fat", "protein"))
OPEN = make_sheet(matrix="liquid", optics="unknown", domain="dairy_food", targets=("fat", "protein"))


# ---------------------------------------------------------------- test kit (also used by test_turns_api.py)

class AgentFake(FakeGateway):
    """FakeGateway whose `agent` items may call tools: a list of (wire name, arguments) pairs is one model turn that
    calls those tools, a string is a final answer, a callable gets the messages and returns either."""

    def complete(self, role, messages, schema=None, reasoning=None, max_tokens=None, tools=None):
        if role != "agent" or schema is not None:
            return super().complete(role, messages, schema, reasoning, max_tokens, tools)
        with self._lock:
            self.requests.append({"role": role, "messages": list(messages),
                                  "tools": [t["function"]["name"] for t in tools or []]})
            item = self.scripted["agent"].pop(0)
        if callable(item):
            item = item(messages)
        if isinstance(item, Exception):
            raise item
        if isinstance(item, LLMResult):
            return item
        if isinstance(item, list):
            calls = [ToolCall(id=f"call-{uuid.uuid4().hex[:6]}", name=name, arguments=json.dumps(args))
                     for name, args in item]
            return LLMResult(text="", model="fake-agent", tool_calls=calls)
        return LLMResult(text=item, model="fake-agent")


def source_ids(messages) -> list[str]:
    """The source card ids listed in a system prompt (summary or agent mode)."""
    system = messages[0]["content"]
    return system.split("Source card ids:")[1].split("\n")[0].strip().split(", ")


def summary(messages) -> str:
    """A summary call that cites the report's first source (and slips in a number nobody stated)."""
    return (f"**Provisional: NIR diffuse reflection probe.** It suits opaque products [{source_ids(messages)[0]}]. "
            "The client's fat level is 3.5 % here. Two points stay open for the client.")


class Env:
    """An API with fake models: every pipeline gets its own workflow_fake; the chat gateway scripts the agent."""

    def __init__(self, kb, tmp_path, sheet=SETTLED, agent=(), web=None, gate=None, **scripted):
        harness.STREAM_PAUSE_S = 0
        self.kb, self.sheet, self.gate = kb, sheet, gate
        self.pipelines: list[FakeGateway] = []
        self.seen: list[dict] = []
        self.chat = AgentFake({"agent": list(agent), **scripted})
        self.store = Store(tmp_path / f"prism-{uuid.uuid4().hex[:6]}.db")
        self.app = create_app(self.factory, self.store, kb, gateway=self.chat, materials=MAT, web=web)

    def factory(self, deep, emit, web=False):
        self.seen.append({"deep": deep, "web": web})
        gw = workflow_fake(self.sheet)
        if self.gate is not None:
            from prism.assist.sections import PlanSection
            plain, gate = gw.complete, self.gate

            def complete(role, messages, schema=None, **kw):
                if schema is PlanSection:
                    gate.wait(10)
                return plain(role, messages, schema, **kw)
            gw.complete = complete
        self.pipelines.append(gw)
        return Pipeline(gw, self.kb, MAT, PipelineFlags(deep=deep, web=web), emit=emit)

    def __enter__(self):
        self.client = TestClient(self.app).__enter__()
        return self

    def __exit__(self, *exc):
        if self.gate is not None:
            self.gate.set()
        self.client.__exit__(*exc)

    # ------------------------------------------------------------ calls

    def session(self, text=TEXT) -> str:
        return self.client.post("/api/sessions", json={"text": text}).json()["id"]

    def turn(self, sid, **body) -> str:
        r = self.client.post(f"/api/sessions/{sid}/turns", json=body)
        assert r.status_code == 200, r.text
        return r.json()["turn_id"]

    def events(self, tid, last_id=None) -> list[dict]:
        headers = {"Last-Event-ID": str(last_id)} if last_id is not None else {}
        with self.client.stream("GET", f"/api/turns/{tid}/events", headers=headers) as r:
            assert r.headers["content-type"].startswith("text/event-stream")
            text = "".join(r.iter_text())
        return [json.loads(line[5:]) for line in text.splitlines() if line.startswith("data:")]

    def wait(self, tid, type_, count=1, timeout=10.0) -> dict:
        """The `count`-th event of a type, once the turn has emitted it."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            hits = [e for e in self.store.turn_events(tid) if e["type"] == type_]
            if len(hits) >= count:
                return hits[count - 1]
            time.sleep(0.02)
        raise AssertionError(f"no {type_} event in {[e['type'] for e in self.store.turn_events(tid)]}")

    def answer(self, tid, event, **answers):
        """Answer a question card: the given values, 'not known yet' for the rest."""
        qs = event["payload"]["questions"]
        body = {q["id"]: ({"value": answers[q["id"]]} if q["id"] in answers else {"unknown": True}) for q in qs}
        return self.client.post(f"/api/turns/{tid}/answer",
                                json={"question_id": event["payload"]["question_id"], "answers": body})

    def approve(self, tid, event, ok=True):
        return self.client.post(f"/api/turns/{tid}/approve",
                                json={"approval_id": event["payload"]["approval_id"], "approved": ok})

    def assessed(self, text=TEXT) -> tuple[str, list[dict]]:
        """A session whose first turn ran the fast path to a report (the agent's next item must be a summary)."""
        sid = self.session(text)
        tid = self.turn(sid, text=text)
        if self.sheet is OPEN:
            self.answer(tid, self.wait(tid, "question"))
        events = self.events(tid)
        assert events[-1]["type"] == "turn_completed", events[-1]
        return sid, events

    def roles(self) -> list[str]:
        return [r["role"] for g in self.pipelines for r in g.requests]


def types(events) -> list[str]:
    """Event types with runs of message_delta folded into one."""
    out = []
    for e in events:
        if not (e["type"] == "message_delta" and out and out[-1] == "message_delta"):
            out.append(e["type"])
    return out


# ---------------------------------------------------------------- calculators (docs/ARCHITECTURE_V2.md §3.5)

def test_calculators_reproduce_the_reference_values(kb):
    assert convert(785, "nm", "cm-1")["value"] == 12738.9
    assert convert(4000, "cm-1", "um")["value"] == 2.5 and convert(2.5, "µm", "nm")["value"] == 2500
    assert raman_absolute(1000, 785)["wavelength_nm"] == 851.9
    assert raman_absolute(1000, 532)["wavelength_nm"] == 561.9
    assert raman_absolute(-1000, 785)["side"] == "anti-Stokes"
    mir = fiber_window(kb, "MIR", "visnir_silica")
    assert mir["blocked"] is True and mir["overlap"] is False and "no overlap" in mir["text"]
    assert {c["id"] for c in mir["cards"]} >= {"S02-p06-visnir-silica", "S01-p09-mir-range"}
    assert fiber_window(kb, "NIR", "visnir_silica")["blocked"] is False
    assert loss_budget(30)["status"] == "ask"                           # never assumes an attenuation
    assert loss_budget(30, 0.1)["loss_db"] == 3.0 and loss_budget(30, db_per_km=100)["loss_db"] == 3.0
    assert atr_depth(2.4, 1.5, 45, 1000)["depth_um"] == 2.01             # diamond or ZnSe, 1000 cm-1
    for result in (convert(785, "nm", "cm-1"), raman_absolute(1000, 785), atr_depth(2.4, 1.5, 45, 1000)):
        assert result["provenance"] == "computed" and result["text"]
    with pytest.raises(ValueError):
        convert(1, "eV", "nm")
    with pytest.raises(ValueError):
        atr_depth(1.5, 1.6, 45, 1000)                                    # no total internal reflection


def test_calculator_inputs_must_come_from_the_session(kb):
    view = SessionView(sources=["The analyzer would sit 30 m from the pipe."])
    tools = {t.name: t for t in domain_tools(kb, Retriever(kb), view)}
    loss = tools["calc.loss_budget"]
    invented = loss.fn({"length_m": 30, "db_per_m": 0.2})
    assert invented["status"] == "ask" and "not used" in invented["note"]
    view.sources.append("The process target is 0.2 %.")
    assert loss.fn({"length_m": 30, "db_per_m": 0.2})["status"] == "ask"
    assert loss.fn({"length_m": 50})["status"] == "ask" and "length" in loss.fn({"length_m": 50})["error"]
    view.sources.append("The datasheet gives 0.2 dB/m.")
    assert loss.fn({"length_m": 30, "db_per_m": 0.2})["loss_db"] == 6.0
    view.sources.append("Please compute the depth at 1000 cm-1.")
    assert tools["calc.atr_depth"].fn({"crystal": "diamond", "wavenumber_cm1": 1000})["assumed"] == ["n2", "angle_deg"]
    assert tools["calc.convert"].fn({"value": 785, "from_unit": "nm", "to_unit": "cm-1"})["status"] == "ask"
    assert tools["calc.raman"].fn({"shift_cm1": 1000, "excitation_nm": 785})["status"] == "ask"
    view.sources.append("The excitation is 785 nm.")
    assert tools["calc.raman"].fn({"shift_cm1": 1000, "excitation_nm": 785})["wavelength_nm"] == 851.9
    assert {t.wire for t in tools.values()} >= {"kb_search", "calc_convert", "engine_explain", "report_diff"}


def test_engine_explain_rules_and_candidates(kb):
    from prism.assist.sections import with_application_candidates
    from prism.rules.engine import evaluate
    findings = with_application_candidates(evaluate(SETTLED, kb), SETTLED, kb)
    rule = explain(kb, findings, "R-FIBER-WINDOW")
    assert rule["rule_id"] == "R-FIBER-WINDOW" and "fired" in rule
    nir = explain(kb, findings, "NIR diffuse reflection probe")
    assert nir["candidates"][0]["rank"] == 1 and set(nir["candidates"][0]["parts"]) == {
        "sample fit", "optical access", "AFS evidence", "fiber link"}
    assert nir["cards"] and "error" in explain(kb, findings, "telepathy")


# ---------------------------------------------------------------- the answer verifier

def test_verifier_keeps_grounded_markdown_and_drops_the_rest(kb):
    text = ("**NIR fits** the opaque product [S01-p10-nir-range].\n\n"
            "- The nominal NIR range is 780–2500 nm [S01-p10-nir-range].\n"
            "- It reaches 0.37 % accuracy in your process.\n"
            "- See also [S99-p01-made-up] for details.")
    out, removed = verify_answer(text, kb, {"S01-p10-nir-range"}, ["opaque product"])
    assert removed == 1 and "0.37" not in out and "S99" not in out
    assert out.splitlines()[0].startswith("**NIR fits**") and out.splitlines()[1] == ""
    assert "- The nominal NIR range is 780–2500 nm [S01-p10-nir-range]." in out.splitlines()
    unseen, _ = verify_answer("Raman is weak [S01-p05-raman-weak].", kb, set(), [])
    assert "[S01-p05-raman-weak]" not in unseen                          # a real card, but no tool returned it
    both, _ = verify_answer("NIR fits [S01-p10-nir-range, S99-p01-made-up].", kb, {"S01-p10-nir-range"}, [])
    assert both == "NIR fits [S01-p10-nir-range]."
    assert verify_answer("A [non-GMP] pilot line.", kb, set(), [])[0] == "A [non-GMP] pilot line."
    assert verify_answer("The accuracy is 5 %.", kb, set(), []) == ("", 1)
    assert verify_answer("Write a poem about autumn leaves.", kb, set(), []) == ("", 1)
    assert "S99" not in verify_answer("Read [S99-p01-fake].", kb, {"S99-p01-fake"}, [])[0]


@pytest.mark.parametrize("fn,args", [(convert, (0, "nm", "um")), (convert, (float("nan"), "nm", "um")),
                                    (raman_absolute, (float("inf"), 785)),
                                    (loss_budget, (30, float("nan"))), (atr_depth, (2.4, 1.5, 90, 1000)),
                                    (atr_depth, (2.4, 1.5, 45, None, -1))])
def test_calculators_reject_nonphysical_inputs(fn, args):
    with pytest.raises(ValueError):
        fn(*args)


# ---------------------------------------------------------------- turn primitives

def test_turn_waits_for_its_own_card_and_stops_cleanly(tmp_path):
    store = Store(tmp_path / "prism.db")
    sid = store.create_session("t", text="enquiry")
    turn = Turn(store, store.create_turn(sid, "text", {"text": "x"}), sid)
    turn.emit("plan", steps=[{"id": "a", "label": "A", "status": "active"}])
    got = {}

    def worker():
        got["reply"] = turn.wait_for("question", "q1", {"question_id": "q1", "title": "t", "questions": []})

    t = threading.Thread(target=worker)
    t.start()
    while turn.waiting is None:
        time.sleep(0.01)
    assert store.turn(turn.id)["status"] == "waiting" and store.turn(turn.id)["pending"]["type"] == "question"
    assert turn.reply("question", "other", {}) is False and turn.reply("approval", "q1", True) is False
    assert turn.reply("question", "q1", {"answers": {"x": {"unknown": True}}}) is True
    t.join(2)
    assert got["reply"] == {"answers": {"x": {"unknown": True}}} and store.turn(turn.id)["status"] == "running"

    def blocked():
        try:
            turn.wait_for("approval", "a1", {"approval_id": "a1"})
        except Stopped:
            got["stopped"] = True

    t = threading.Thread(target=blocked)
    t.start()
    while turn.waiting is None:
        time.sleep(0.01)
    turn.stop()
    t.join(2)
    events = store.turn_events(turn.id)
    assert got["stopped"] and [e["type"] for e in events][-2:] == ["plan", "turn_completed"]
    assert events[-2]["payload"]["steps"][0]["status"] == "pending"
    assert events[-1]["payload"] == {"message": STOPPED_MESSAGE, "citations": {}, "stopped": True}
    assert store.turn(turn.id)["status"] == "stopped" and turn.emit("plan", steps=[]) is None
    with pytest.raises(Stopped):
        turn.check()


# ---------------------------------------------------------------- answers to a question card

def test_answers_apply_values_defer_unknowns_and_skip_what_does_not_fit(kb):
    gw = workflow_fake(OPEN, classifier=[{"value": "turbid"}])
    wf = Workflow(gw, kb, PipelineFlags(), materials=MAT)
    p = wf.prepare(Enquiry(case_id="T1", title="Dairy", text=TEXT, sha256=sha256_text(TEXT)))
    by_slot = {q.slot: q for q in p.questions}
    assert {"streams.s1.optics", "distance"} <= set(by_slot)
    after, applied, notes = apply_answers(wf, p, [by_slot["streams.s1.optics"], by_slot["distance"]],
                                          {"streams.s1.optics": {"value": "opaque"}, "distance": {"unknown": True}})
    assert after.confirmed == {"streams.s1.optics": "opaque"} and "distance" in after.deferred and not notes
    assert applied == [f"{by_slot['streams.s1.optics'].text} → Opaque, such as milky or dense"]
    bad, applied, notes = apply_answers(wf, p, [by_slot["distance"]], {"distance": {"value": "on the moon"}})
    assert applied == [] and "on the moon" in notes[0] and bad.confirmed == {}
    other, applied, _ = apply_answers(wf, p, [by_slot["streams.s1.optics"]],
                                      {"streams.s1.optics": {"other": "a bit cloudy really"}})
    assert other.confirmed == {"streams.s1.optics": "turbid"} and applied
    assert [r["role"] for r in gw.requests] == ["extractor", "classifier"]        # clicks cost nothing


def test_run_seed_carries_the_verdict_after_the_answers(kb):
    wf = Workflow(workflow_fake(OPEN), kb, PipelineFlags(), materials=MAT)
    p = wf.prepare(Enquiry(case_id="T1", title="Dairy", text=TEXT, sha256=sha256_text(TEXT)))
    after = wf.answer(p, "streams.s1.optics", "opaque")
    seed = run_seed(after)
    kinds = [e["type"] for e in seed]
    assert kinds.count("engine_ready") == 1 and kinds[-1] == "engine_ready"
    assert seed[-1]["payload"] == after.preview() and seed[-1]["payload"] != p.preview()
    assert {"seq", "run_id"}.isdisjoint(seed[0])


def test_code_summary_uses_verified_report_sentences():
    from tests.test_chat import report
    text = code_summary(report())
    assert text.startswith("**Provisional: NIR diffuse reflection probe.**") and "Questions tab" in text
