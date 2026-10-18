from pathlib import Path

from prism.assist.sections import AnswerSection
from prism.cases import sha256_text
from prism.orchestrator import Pipeline, PipelineFlags
from prism.schemas import DecisionStatus, Enquiry
from tests.factories import make_sheet
from tests.fakes import OK_JUDGE, FakeGateway, judged_answer, workflow_fake

MAT = Path(__file__).resolve().parents[1] / "materials"
TEXT = "We need to monitor water content in a liquid stream. What should we test first?"
OK_CRITIC = OK_JUDGE        # the batched support judge replaced the per-sentence critic


def run(kb, text=TEXT, gateway=None, flags=None):
    gw = gateway if gateway is not None else workflow_fake()
    events = []
    result = Pipeline(gw, kb, MAT, flags or PipelineFlags(), emit=events.append).run(
        Enquiry(case_id="T1", title="Water", text=text, sha256=sha256_text(text)))
    return result, events, gw


def test_end_to_end_with_fake_models(kb):
    result, events, gw = run(kb)
    assert result.report.decision_status == DecisionStatus.PROVISIONAL
    assert result.verification.passed and all(result.report.compliance.values())
    stages = [e["stage"] for e in events if e["type"] == "stage_completed"]
    assert stages == ["scope", "extract", "normalise", "rules", "retrieve", "write", "verify", "render"]
    assert events[-1]["type"] == "run_completed" and "## Direct answer" in result.markdown
    assert result.manifest.input_sha256 == sha256_text(TEXT) and result.manifest.kb_version == kb.version
    # extract (1) + three parallel writers (3). Empty drafts leave every sentence to code (card claims and template
    # wording), which is supported by construction: nothing for the judge, nothing to patch.
    assert sorted(r["role"] for r in gw.requests) == ["extractor", "writer", "writer", "writer"]
    assert set(result.manifest.timings) == set(stages)


def test_written_prose_costs_one_batched_judge_call(kb):
    sheet = make_sheet(matrix="liquid", targets=("water content",))
    gw = workflow_fake(sheet, sections={AnswerSection: judged_answer(kb, sheet)})
    result, _, gw = run(kb, gateway=gw)
    assert sorted(r["role"] for r in gw.requests) == ["extractor", "judge", "writer", "writer", "writer"]
    assert result.verification.judge_model == "fake-judge" and result.manifest.model_ids["judge"] == "fake-judge"
    assert all(result.report.compliance.values())


def test_off_topic_is_refused_before_extraction(kb):
    result, events, gw = run(kb, text="Write a poem about autumn leaves.", gateway=FakeGateway({}))
    assert result.report is None and events[-1]["type"] == "run_refused"
    assert "Example:" in result.markdown and gw.requests == []


def test_run_id_is_deterministic(kb):
    a, _, _ = run(kb)
    b, _, _ = run(kb)
    assert a.manifest.run_id == b.manifest.run_id
