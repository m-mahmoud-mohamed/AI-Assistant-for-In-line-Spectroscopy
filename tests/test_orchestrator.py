from pathlib import Path

from prism.cases import sha256_text
from prism.orchestrator import Pipeline, PipelineFlags
from prism.schemas import DecisionStatus, Enquiry, Recommendation, RecRole
from tests.factories import make_sheet, minimal_body, seg
from tests.fakes import FakeGateway

MAT = Path(__file__).resolve().parents[1] / "materials"
TEXT = "We need to monitor water content in a liquid stream. What should we test first?"
OK_CRITIC = {"verdicts": [], "direct_answer_responsive": True, "in_scope": True}


def body():
    from prism.schemas import ClaimType
    rec = Recommendation(methods=["NIR"], technique="transmission or transflection probe", role=RecRole.PRIMARY,
                         rationale=[seg("The nominal NIR range is 780–2500 nm.", ClaimType.AFS, ["S01-p10-nir-range"])])
    return minimal_body(recommendations=[rec], spectral_ranges=[])


def run(kb, text=TEXT, scripted=None):
    gw = FakeGateway(scripted or {
        "extractor": [make_sheet(matrix="liquid", targets=("water content",)).model_dump(mode="json")],
        "generator": [body()], "critic": [OK_CRITIC]})
    events = []
    result = Pipeline(gw, kb, MAT, PipelineFlags(), emit=events.append).run(
        Enquiry(case_id="T1", title="Water", text=text, sha256=sha256_text(text)))
    return result, events, gw


def test_end_to_end_with_fake_models(kb):
    result, events, _ = run(kb)
    assert result.report.decision_status == DecisionStatus.PROVISIONAL
    assert result.verification.passed and all(result.report.compliance.values())
    stages = [e["stage"] for e in events if e["type"] == "stage_completed"]
    assert stages == ["scope", "extract", "normalise", "rules", "retrieve", "draft", "verify", "render"]
    assert events[-1]["type"] == "run_completed" and "## Direct answer" in result.markdown
    assert result.manifest.input_sha256 == sha256_text(TEXT) and result.manifest.kb_version == kb.version


def test_off_topic_is_refused_before_extraction(kb):
    result, events, gw = run(kb, text="Write a poem about autumn leaves.", scripted={})
    assert result.report is None and events[-1]["type"] == "run_refused"
    assert "Example:" in result.markdown and gw.requests == []


def test_run_id_is_deterministic(kb):
    a, _, _ = run(kb)
    b, _, _ = run(kb)
    assert a.manifest.run_id == b.manifest.run_id
