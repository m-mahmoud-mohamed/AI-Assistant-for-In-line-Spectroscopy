"""Evaluation metrics, rubric judge and ablation runner (FakeGateway only, no network)."""
from __future__ import annotations

from pathlib import Path

import yaml

from eval.metrics import aggregate, case_metrics
from eval.run_eval import judge_report, load_rubric, load_synthetic_cases
from eval.run_eval import main as run_eval_main
from prism.cases import load_eval_cases
from prism.orchestrator import RunResult
from prism.schemas import (
    AssessmentReport,
    ClaimVerdict,
    DecisionStatus,
    EvidencePack,
    Issue,
    PremiseCheck,
    PremiseVerdict,
    Requirements,
    RunManifest,
    ScopeDecision,
    ScopeLabel,
    StatedFact,
    VerificationReport,
)
from tests.factories import make_sheet, minimal_body, seg
from tests.fakes import FakeGateway
from tests.test_orchestrator import OK_CRITIC, body

ROOT = Path(__file__).resolve().parents[1]
MAT = ROOT / "materials"
EVAL_DIR = ROOT / "eval"


def _result(kb, status=DecisionStatus.PROVISIONAL, premise_checks=(), issues=(), verdicts=(), stated=(),
            extra_ids=(), scope=ScopeLabel.IN_SCOPE) -> RunResult:
    b = minimal_body(decision_status=status, premise_checks=list(premise_checks),
                     requirements=Requirements(stated_facts=list(stated)))
    if extra_ids:
        b.decision_basis.append(seg("Extra claim.", ids=list(extra_ids)))
    report = AssessmentReport(**b.model_dump(), case_id="T1", input_sha256="x", run_id="r1", created_at="t",
                              kb_version=kb.version, profile="fake")
    manifest = RunManifest(run_id="r1", case_id="T1", input_sha256="x", kb_version=kb.version, profile="fake",
                           timings={"scope": 0.5, "draft": 1.25})
    pack = EvidencePack(cards=kb.cards_for(["S01-p10-nir-range", "S01-p17-nir-reflection-opaque"]))
    return RunResult(report, "## Direct answer", manifest, [], ScopeDecision(label=scope, reason="test"),
                     make_sheet(), None, pack, VerificationReport(issues=list(issues), verdicts=list(verdicts)))


def test_case_metrics_counts_issues(kb):
    issues = [Issue(check_id="P-NO-NUMBERS", path="decision_basis[0]", message="42"),
              Issue(check_id="P-NO-NUMBERS", path="risks[0].risk[0]", message="7.5"),
              Issue(check_id="P-NO-SELF-ANSWER", path="requirements.stated_facts[1]", message="not a quote"),
              Issue(check_id="C-SUPPORT", path="x", message="partial", severity="warning")]
    verdicts = [ClaimVerdict(path=f"p{i}", verdict=v)
                for i, v in enumerate(["supported", "supported", "partial", "unsupported"])]
    stated = [StatedFact(slot="matrix", value="liquid", quote="liquid stream"),
              StatedFact(slot="distance", value="remote", quote="far away")]
    m = case_metrics(_result(kb, issues=issues, verdicts=verdicts, stated=stated, extra_ids=["S99-p1-missing"]),
                     None, kb=kb)
    assert m["schema_ok"] is True
    assert m["invented_numbers"] == 2
    assert m["claim_support"] == 0.5
    assert m["fact_fidelity"] == 0.5
    assert m["citation_existence"] == 2 / 3          # two pack cards cited, one unknown id
    assert m["quote_fidelity"] == 1.0                # both seed quotes are on their pages
    assert m["questions_ok"] is True and m["plan_ok"] is True
    assert m["trap_handled"] is None and m["scope_ok"] is None
    assert m["latency_s"] == 1.75


def test_trap_handled_uses_expectations(kb):
    expect = {"status_any_of": ["INSUFFICIENT_INFORMATION", "PROVISIONAL"], "premise_flag": True,
              "screening": False, "scope": "IN_SCOPE"}
    flagged = [PremiseCheck(premise="reuse the NIR cable", verdict=PremiseVerdict.CONTRADICTED,
                            explanation=[seg("Silica fibers do not carry mid-IR.")])]
    supported = [PremiseCheck(premise="reuse the NIR cable", verdict=PremiseVerdict.SUPPORTED,
                              explanation=[seg("Fine.")])]
    assert case_metrics(_result(kb, premise_checks=flagged), expect)["trap_handled"] is True
    assert case_metrics(_result(kb, premise_checks=supported), expect)["trap_handled"] is False
    assert case_metrics(_result(kb), expect)["trap_handled"] is False                 # premise never checked
    wrong_status = {**expect, "status_any_of": ["OUTSIDE_SUPPORTED_SCOPE"]}
    assert case_metrics(_result(kb, premise_checks=flagged), wrong_status)["trap_handled"] is False
    no_premise = {**expect, "premise_flag": False}
    assert case_metrics(_result(kb), no_premise)["trap_handled"] is True
    assert case_metrics(_result(kb), no_premise)["scope_ok"] is True
    assert case_metrics(_result(kb), {**no_premise, "scope": "PARTIAL"})["scope_ok"] is False

    refused = _result(kb, scope=ScopeLabel.OFF_TOPIC)
    refused.report = None
    off = {"status_any_of": [], "premise_flag": False, "screening": False, "scope": "OFF_TOPIC"}
    m = case_metrics(refused, off)
    assert m["trap_handled"] is True and m["scope_ok"] is True and m["schema_ok"] is None
    assert case_metrics(refused, no_premise)["trap_handled"] is False                 # in-scope case refused


def test_aggregate_averages():
    rows = [{"schema_ok": True, "claim_support": 1.0, "invented_numbers": 2, "trap_handled": None, "latency_s": 2.0},
            {"schema_ok": False, "claim_support": 0.5, "invented_numbers": 0, "trap_handled": True, "latency_s": 4.0},
            {"schema_ok": True, "claim_support": None, "invented_numbers": 1, "trap_handled": False,
             "latency_s": 6.0, "error": "boom"}]
    agg = aggregate(rows)
    assert agg["n"] == 3 and agg["errors"] == 1
    assert agg["schema_ok"] == round(2 / 3, 3)
    assert agg["claim_support"] == 0.75               # None is skipped, not counted as 0
    assert agg["invented_numbers"] == 1.0 and agg["invented_numbers_total"] == 3
    assert agg["trap_handled"] == 0.5 and agg["latency_s"] == 4.0
    assert aggregate([])["n"] == 0


def test_eval_files_do_not_contain_eval_scenarios():
    titles = [(c.case_id, c.title.strip().casefold()) for c in load_eval_cases(MAT)]
    assert len(titles) == 6
    files = [p for p in EVAL_DIR.rglob("*") if p.is_file() and "results" not in p.relative_to(EVAL_DIR).parts
             and "__pycache__" not in p.parts]
    assert files
    leaks = [(p.name, cid) for p in files for cid, title in titles
             if title and title in p.read_text(encoding="utf-8", errors="ignore").casefold()]
    assert leaks == [], f"held-out titles found (case ids only): {leaks}"


def test_synthetic_cases_and_rubric_are_well_formed():
    cases = load_synthetic_cases()
    assert len(cases) == 12 and len({c["id"] for c in cases}) == 12
    for c in cases:
        e = c["expect"]
        assert set(e) == {"status_any_of", "premise_flag", "screening", "scope"}
        assert e["scope"] in {"IN_SCOPE", "PARTIAL", "OFF_TOPIC", "UNSAFE"}
        assert all(s in DecisionStatus.__members__ for s in e["status_any_of"])
    rubric = load_rubric()
    assert [c["weight"] for c in rubric["criteria"]] == [30, 20, 15, 15, 10, 10]
    assert all(2 <= len(c["questions"]) <= 4 for c in rubric["criteria"])
    assert "padding" in rubric["judge_prompt"].lower() and "0" in rubric["judge_prompt"]
    yaml.safe_load((EVAL_DIR / "synthetic_cases.yaml").read_text(encoding="utf-8"))


def test_judge_report_weights_scores():
    rubric = load_rubric()
    scores = [{"question_id": q["id"], "score": 4, "reason": "ok"} for c in rubric["criteria"] for q in c["questions"]]
    first = rubric["criteria"][0]
    scores = [s if s["question_id"] not in {q["id"] for q in first["questions"]} else {**s, "score": 2}
              for s in scores]
    gw = FakeGateway({"critic": [{"scores": scores, "padding": []}]})
    out = judge_report("Some enquiry.", "## Direct answer\nText.", rubric, gw)
    assert gw.requests[0]["role"] == "critic"
    assert out["criteria"][first["id"]] == 15.0       # half of 30
    assert out["total"] == 85.0


def test_run_eval_writes_summary_with_fake_gateway(kb, tmp_path):
    n = 40
    gw = FakeGateway({"extractor": [make_sheet().model_dump(mode="json") for _ in range(n)],
                      "generator": [body() for _ in range(n)], "critic": [OK_CRITIC] * n,
                      "classifier": [{"label": "IN_SCOPE", "reason": "test"}] * n})
    code = run_eval_main(["--configs", "full,baseline", "--set", "synthetic", "--limit", "2", "--out", str(tmp_path)],
                         gateway=gw, kb=kb, materials=MAT)
    assert code == 0
    (run_dir,) = [p for p in tmp_path.iterdir() if p.is_dir()]
    summary = (run_dir / "summary.md").read_text(encoding="utf-8")
    assert "full" in summary and "baseline" in summary and "trap_handled" in summary
    rows = (run_dir / "rows.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(rows) == 4
    assert (run_dir / "summary.json").exists()
