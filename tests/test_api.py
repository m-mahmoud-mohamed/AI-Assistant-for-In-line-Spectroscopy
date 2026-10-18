import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from prism.api import create_app
from prism.llm.cache import LLMCache
from prism.llm.gateway import LLMGateway
from prism.llm.profiles import load_profile
from prism.orchestrator import Pipeline, PipelineFlags
from prism.store import Store
from tests.fakes import workflow_fake
from tests.test_orchestrator import TEXT

ROOT = Path(__file__).resolve().parents[1]
MAT = ROOT / "materials"


def fake_factory(kb, fail: bool = False):
    def factory(deep, emit):
        if fail:
            raise RuntimeError("boom")
        return Pipeline(workflow_fake(), kb, MAT, PipelineFlags(deep=deep), emit=emit)
    return factory


@pytest.fixture
def client(kb, tmp_path):
    app = create_app(fake_factory(kb), Store(tmp_path / "prism.db"), kb, materials=MAT)
    with TestClient(app) as c:
        yield c


def start(client, text=TEXT) -> tuple[str, str]:
    sid = client.post("/api/sessions", json={"text": text, "title": "Water"}).json()["id"]
    r = client.post(f"/api/sessions/{sid}/runs", json={})
    assert r.status_code == 200
    return sid, r.json()["run_id"]


def sse_events(client, run_id) -> list[dict]:
    with client.stream("GET", f"/api/runs/{run_id}/events") as r:
        assert r.headers["content-type"].startswith("text/event-stream")
        text = "".join(r.iter_text())
    return [json.loads(line[5:]) for line in text.splitlines() if line.startswith("data:")]


def wait_report(client, run_id, timeout=20.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        r = client.get(f"/api/runs/{run_id}/report")
        if r.status_code != 409:
            return r
        time.sleep(0.05)
    raise AssertionError("run did not finish")


def test_session_run_report_flow(client):
    sid, run_id = start(client)
    events = sse_events(client, run_id)
    assert events and all(e["run_id"] == run_id for e in events)
    assert [e["seq"] for e in events] == list(range(len(events)))
    r = wait_report(client, run_id)
    assert r.status_code == 200
    rep = r.json()
    assert rep["decision_status"] == "PROVISIONAL" and rep["recommendations"]
    assert "candidates" in rep["findings"] and "question_seeds" in rep["findings"]
    assert rep["scope"]["label"] in ("IN_SCOPE", "PARTIAL")
    md = client.get(f"/api/runs/{run_id}/report.md")
    assert md.headers["content-type"].startswith("text/markdown") and "## Direct answer" in md.text
    session = client.get(f"/api/sessions/{sid}").json()
    assert session["messages"][0]["kind"] == "enquiry" and session["messages"][0]["text"] == TEXT
    assert session["reports"] == [{"version": 1, "run_id": run_id, "created_at": session["reports"][0]["created_at"],
                                   "decision_status": "PROVISIONAL", "trigger": "", "summary": "",
                                   "changed_sections": []}]
    assert rep["version_info"]["version"] == 1 and rep["version_info"]["summary"] == "Initial assessment."
    assert rep["original_enquiry"] == TEXT
    assert [s["id"] for s in client.get("/api/sessions").json()] == [sid]
    assert client.get("/api/runs/nope/report").status_code == 404
    assert client.get("/api/kb/cards/S01-p10-nir-range").json()["page"] == 10
    spectral = client.get("/api/kb/spectral").json()
    nir = next(m for m in spectral["methods"] if m["id"] == "NIR")
    assert nir["range_um"] == [0.78, 2.5] and round(nir["range_cm1"][0]) == 4000
    assert spectral["fibers"] and spectral["instruments"] == []


def test_events_stream_contains_completion(client):
    _, run_id = start(client)
    events = sse_events(client, run_id)
    assert events[-1]["type"] == "run_completed"
    # A finished run replays from the events table.
    assert [e["type"] for e in sse_events(client, run_id)] == [e["type"] for e in events]


def test_stream_carries_engine_ready_then_sections_then_completion(client):
    _, run_id = start(client)
    events = sse_events(client, run_id)
    types = [e["type"] for e in events]
    assert types.index("engine_ready") < types.index("section_ready") and types[-1] == "run_completed"
    engine = next(e for e in events if e["type"] == "engine_ready")
    assert engine["stage"] == "rules" and engine["payload"]["status"] == "PROVISIONAL"
    assert engine["payload"]["candidates"] and engine["payload"]["spectral_methods"]
    assert sorted(e["payload"]["section"] for e in events if e["type"] == "section_ready") == [
        "answer", "concept", "plan"]
    stages = {e["stage"] for e in events}
    assert {"write", "verify"} <= stages and not {"draft", "repair"} & stages


def test_refused_run_returns_422(client):
    _, run_id = start(client, "Write a poem about autumn leaves.")
    assert sse_events(client, run_id)[-1]["type"] == "run_refused"
    r = wait_report(client, run_id)
    assert r.status_code == 422 and r.json()["refused"] is True and r.json()["markdown"]


def test_failed_run_emits_run_failed(kb, tmp_path):
    app = create_app(fake_factory(kb, fail=True), Store(tmp_path / "prism.db"), kb, materials=MAT)
    with TestClient(app) as c:
        _, run_id = start(c)
        last = sse_events(c, run_id)[-1]
        assert last["type"] == "run_failed" and "boom" in last["payload"]["error"]


def test_page_image_with_highlight(client):
    r = client.get("/api/kb/pages/S01/10.png", params={"highlight": "S01-p10-nir-range"})
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    assert r.content[:8] == b"\x89PNG\r\n\x1a\n" and int(r.headers["x-highlight-count"]) >= 1


def test_unknown_page_is_404(client):
    assert client.get("/api/kb/pages/S01/999.png").status_code == 404
    assert client.get("/api/kb/pages/S99/1.png").status_code == 404
    assert client.get("/api/kb/cards/no-such-card").status_code == 404


def test_health_reports_profile_and_kb(kb, tmp_path):
    profile = load_profile(ROOT / "config" / "llm.yaml")
    gw = LLMGateway(profile, adapter=None, cache=LLMCache(tmp_path / "cache", replay=True))
    app = create_app(fake_factory(kb), Store(tmp_path / "prism.db"), kb, gateway=gw, materials=MAT)
    with TestClient(app) as c:
        h = c.get("/api/health").json()
    assert h["status"] == "ok" and h["profile"] == profile.name and h["replay"] is True
    assert h["kb_hash"] == kb.version
    assert h["routing"]["writer"] == profile.roles["writer"].models[0]
    assert all(isinstance(v, int) for v in h["budget"].values())
