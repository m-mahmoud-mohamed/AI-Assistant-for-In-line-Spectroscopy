"""Evaluation metrics, gold fields, rubric judge and ablation runner (FakeGateway only, no network)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

from eval.metrics import (
    DECISION_IMPACTS,
    GOLD_KEYS,
    RUN_KEYS,
    aggregate,
    by_trap,
    case_metrics,
    event_times,
    premise_agreement,
    question_value,
    run_metrics,
    usage_stats,
)
from eval.recorder import usage_numbers
from eval.run_eval import TRAPS, judge_report, load_dev_gold, load_rubric, load_synthetic_cases, select_cases
from eval.run_eval import main as run_eval_main
from eval.rundir import load_case, stored_run_metrics
from eval.stats import bootstrap, cohen_kappa, confusion, mean_ci, percentile, ppi_mean
from prism.cases import load_dev_cases, load_eval_cases
from prism.orchestrator import RunResult
from prism.schemas import (
    METHODS,
    AssessmentReport,
    ClaimVerdict,
    ClarifyQuestion,
    DecisionStatus,
    DirectAnswer,
    EvidencePack,
    Issue,
    PremiseCheck,
    PremiseVerdict,
    Recommendation,
    RecRole,
    Requirements,
    RunManifest,
    ScopeDecision,
    ScopeLabel,
    StatedFact,
    Verdict,
    VerificationReport,
)
from prism.stages.checks import direct_answer_problems
from tests.factories import make_sheet, minimal_body, seg
from tests.fakes import FakeGateway, workflow_fake

ROOT = Path(__file__).resolve().parents[1]
MAT = ROOT / "materials"
EVAL_DIR = ROOT / "eval"
BRIEF_TRAPS = ("missing_info", "out_of_source", "contradicted_premise", "multi_stream", "aqueous_fluorescence",
               "fiber_window", "calibration_transfer", "evidence_scope")
EXPECT_KEYS = {"scope", "status_any_of", "premise_flag", "screening", "status", "methods", "techniques", "premises",
               "cite", "streams"}


def _result(kb, status=DecisionStatus.PROVISIONAL, premise_checks=(), issues=(), verdicts=(), stated=(),
            extra_ids=(), scope=ScopeLabel.IN_SCOPE, events=(), **body) -> RunResult:
    b = minimal_body(decision_status=status, premise_checks=list(premise_checks),
                     requirements=Requirements(stated_facts=list(stated)), **body)
    if extra_ids:
        b.decision_basis.append(seg("Extra claim.", ids=list(extra_ids)))
    report = AssessmentReport(**b.model_dump(), case_id="T1", input_sha256="x", run_id="r1", created_at="t",
                              kb_version=kb.version, profile="fake")
    manifest = RunManifest(run_id="r1", case_id="T1", input_sha256="x", kb_version=kb.version, profile="fake",
                           timings={"scope": 0.5, "write": 1.25})
    pack = EvidencePack(cards=kb.cards_for(["S01-p10-nir-range", "S01-p17-nir-reflection-opaque"]))
    return RunResult(report, "## Direct answer", manifest, list(events), ScopeDecision(label=scope, reason="test"),
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
    assert (m["judge_supported"], m["judge_partial"], m["judge_unsupported"]) == (2, 1, 1)
    assert m["direct_answer_consistent"] is True     # "Start with a comparison study."
    assert all(m[k] is None for k in GOLD_KEYS)       # no gold fields without expectations


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
    assert case_metrics(_result(kb), {**no_premise, "scope": ["PARTIAL", "IN_SCOPE"]})["scope_ok"] is True

    refused = _result(kb, scope=ScopeLabel.OFF_TOPIC)
    refused.report = None
    off = {"status_any_of": [], "premise_flag": False, "screening": False, "scope": "OFF_TOPIC"}
    m = case_metrics(refused, off)
    assert m["trap_handled"] is True and m["scope_ok"] is True and m["schema_ok"] is None
    assert m["status_agreement"] is None                                              # no gold status for off-topic
    assert case_metrics(refused, no_premise)["trap_handled"] is False                 # in-scope case refused
    gold = case_metrics(refused, {**no_premise, "status": "PROVISIONAL", "methods": ["NIR"], "cite": ["S01 p.17"]})
    assert gold["status_agreement"] is False and gold["method_agreement"] is False and gold["cite_recall"] == 0.0


# ---------------------------------------------------------------- gold fields

def test_gold_agreement_status_method_technique_cite_streams(kb):
    expect = {"scope": "IN_SCOPE", "status_any_of": ["PROVISIONAL"], "premise_flag": False, "screening": False,
              "status": "PROVISIONAL", "methods": ["Raman", "NIR"], "techniques": ["reflection"],
              "cite": ["S01 p.17", "S01 p.10", "S02 p.13"], "streams": 1}
    m = case_metrics(_result(kb), expect, kb=kb)
    assert m["status_agreement"] is True and m["method_agreement"] is True and m["technique_agreement"] is True
    assert m["cite_recall"] == pytest.approx(2 / 3)    # p.17 (rationale) and p.10 (spectral caveat) cited, p.13 not
    assert m["streams_ok"] is True
    other = {**expect, "status": "INSUFFICIENT_INFORMATION", "methods": ["MIR"], "techniques": ["ATR"], "streams": 2}
    m = case_metrics(_result(kb), other, kb=kb)
    assert not any(m[k] for k in ("status_agreement", "method_agreement", "technique_agreement", "streams_ok"))


def test_method_agreement_reads_the_primary_recommendation_or_the_first_conditional(kb):
    def rec(method, role):
        return Recommendation(methods=[method], technique="ATR probe" if method == "MIR" else "Raman probe",
                              role=role, rationale=[seg("Why.")])
    expect = {"methods": ["MIR"], "techniques": ["ATR"]}
    conditional = _result(kb, recommendations=[rec("Raman", RecRole.SCREENING), rec("MIR", RecRole.CONDITIONAL),
                                               rec("Raman", RecRole.CONDITIONAL)])
    m = case_metrics(conditional, expect, kb=kb)
    assert m["method_agreement"] is True and m["technique_agreement"] is True
    screening_only = _result(kb, recommendations=[rec("MIR", RecRole.SCREENING)])
    assert case_metrics(screening_only, expect, kb=kb)["method_agreement"] is False


def test_premise_agreement_matches_each_expected_verdict_once():
    assert premise_agreement(["CONTRADICTED"], ["CONTRADICTED"]) is True
    assert premise_agreement(["UNVERIFIABLE"], ["CONTRADICTED"]) is False
    assert premise_agreement(["UNVERIFIABLE"], [["CONTRADICTED", "UNVERIFIABLE"]]) is True
    assert premise_agreement(["UNVERIFIABLE"], ["UNVERIFIABLE", "UNVERIFIABLE"]) is False      # one check, two needed
    assert premise_agreement(["SUPPORTED", "CONTRADICTED"], ["CONTRADICTED"]) is True
    assert premise_agreement([], []) is True and premise_agreement(["SUPPORTED"], []) is True
    assert premise_agreement(["UNVERIFIABLE"], []) is False                                    # a false alarm


def test_premise_agreement_in_case_metrics(kb):
    flagged = [PremiseCheck(premise="reuse the cable", verdict=PremiseVerdict.CONTRADICTED,
                            explanation=[seg("No.")])]
    assert case_metrics(_result(kb, premise_checks=flagged), {"premises": ["CONTRADICTED"]})["premise_agreement"]
    assert case_metrics(_result(kb, premise_checks=flagged), {"premises": []})["premise_agreement"] is False
    assert case_metrics(_result(kb), {"premises": []})["premise_agreement"] is True
    assert case_metrics(_result(kb), {})["premise_agreement"] is None                         # not evaluated


# ---------------------------------------------------------------- the direct answer (P-DIRECT-ANSWER)

def _answer(kb, text, verdict=Verdict.CONDITIONAL, status=DecisionStatus.PROVISIONAL):
    body = minimal_body(decision_status=status, direct_answer=DirectAnswer(verdict=verdict, text=[seg(text)]))
    return direct_answer_problems(body, kb.lexicon.get("methods", {}))


def test_direct_answer_must_agree_with_the_status(kb):
    assert _answer(kb, "Test near-infrared diffuse reflection on retained samples first.") == []
    assert _answer(kb, "Yes: NIR reflection is the method to test.", Verdict.YES) == []
    assert _answer(kb, "Start with a comparison study of the candidate methods.") == []
    assert _answer(kb, "A first feasibility experiment on representative samples is the next step.") == []
    evasive = _answer(kb, "Spectroscopy may help, depending on many factors.")
    assert len(evasive) == 1 and "NIR" in evasive[0]
    assert _answer(kb, "Raman should work.") != []                       # names a method, but not the lead one
    yes = _answer(kb, "Yes.", Verdict.YES, DecisionStatus.INSUFFICIENT_INFORMATION)
    assert yes and "YES" in yes[0]
    assert _answer(kb, "Not yet: the target is undefined.", Verdict.NOT_YET,
                   DecisionStatus.INSUFFICIENT_INFORMATION) == []
    assert _answer(kb, "Only if a new method is found.", Verdict.CONDITIONAL, DecisionStatus.OUTSIDE_SUPPORTED_SCOPE)
    assert _answer(kb, "No supplied source covers this.", Verdict.NO, DecisionStatus.OUTSIDE_SUPPORTED_SCOPE) == []


def test_direct_answer_consistency_feeds_the_check_and_the_metric(kb):
    from prism.schemas import RuleFindings
    from prism.stages.checks import CheckContext, compliance, run_checks
    vague = DirectAnswer(verdict=Verdict.CONDITIONAL, text=[seg("It depends.")])
    pack = EvidencePack(cards=kb.cards_for(["S01-p10-nir-range", "S01-p17-nir-reflection-opaque"]))
    issues = run_checks(CheckContext(minimal_body(direct_answer=vague), make_sheet(), RuleFindings(), pack, kb, ["x"]))
    found = [i for i in issues if i.check_id == "P-DIRECT-ANSWER"]
    assert len(found) == 1 and found[0].path == "direct_answer" and found[0].severity == "error"
    assert compliance(VerificationReport(issues=issues))["P-DIRECT-ANSWER"] is False
    assert case_metrics(_result(kb, direct_answer=vague), None, kb=kb)["direct_answer_consistent"] is False


# ---------------------------------------------------------------- run behaviour (synthetic run dirs)

def _question(slot, impact):
    q = {"id": slot, "slot": slot, "stream_id": None, "text": f"What is {slot}?", "why": "It decides the method.",
         "impact": impact, "multi": False,
         "options": [{"value": "a", "label": "A", "effect": "primary method → Raman"},
                     {"value": "b", "label": "B", "effect": "no change to the recommendation"}]}
    ClarifyQuestion.model_validate(q)                                   # the C2 shape
    return q


def _events(t0=1000.0, questions=(), patched=True):
    ev = [{"type": "stage_started", "stage": "scope", "ts": t0, "payload": {}},
          {"type": "engine_ready", "stage": "rules", "ts": t0 + 3.5,
           "payload": {"status": "PROVISIONAL", "candidates": [], "questions": list(questions),
                       "spectral_methods": []}},
          {"type": "stage_started", "stage": "write", "ts": t0 + 4.0, "payload": {}}]
    if patched:
        ev += [{"type": "stage_started", "stage": "patch", "ts": t0 + 10.0, "payload": {}},
               {"type": "repaired", "stage": "patch", "ts": t0 + 11.0,
                "payload": {"remaining": [], "rounds": 1, "stripped": [],
                            "actions": [{"path": "decision_basis[0]", "action": "hedge", "round": 1},
                                        {"path": "risks[0].risk[0]", "action": "relabel", "round": 1}]}}]
    return ev + [{"type": "run_completed", "stage": "render", "ts": t0 + 12.25, "payload": {}}]


def _calls():
    usage = {"prompt_tokens": 1000, "completion_tokens": 200, "thinking_tokens": 50, "cached_tokens": 400}
    return [{"role": "extractor", "model": "m-mid", "cached": False, "usage": usage, "max_tokens": 3000},
            {"role": "writer", "model": "m-mid", "cached": False, "max_tokens": 1500, "schema": "AnswerSection",
             "usage": {"prompt_tokens": 2000, "completion_tokens": 1490}},                       # at the cap
            {"role": "writer", "model": "m-mid", "cached": True, "max_tokens": 1500, "schema": "ConceptSection",
             "usage": {"prompt_tokens": 2000, "completion_tokens": 700}},
            {"role": "writer", "error": "LLMUnavailable", "max_tokens": 1500, "schema": "PlanSection"},
            {"role": "judge", "model": "m-fast", "cached": False, "max_tokens": 1500,
             "usage": {"input_tokens": 800, "output_tokens": 60}}]                               # Anthropic names


def _write_case(path: Path, events, calls, issues=(), verdicts=(), timings=None, report=None):
    path.mkdir(parents=True)
    (path / "events.jsonl").write_text("".join(json.dumps(e) + "\n" for e in events), encoding="utf-8")
    (path / "calls.json").write_text(json.dumps(calls), encoding="utf-8")
    (path / "manifest.json").write_text(json.dumps({"timings": timings or {}}), encoding="utf-8")
    (path / "verification.json").write_text(json.dumps({
        "issues": [i.model_dump() for i in issues], "verdicts": [v.model_dump() for v in verdicts]}), encoding="utf-8")
    if report is not None:
        (path / "report.json").write_text(json.dumps(report), encoding="utf-8")


def test_run_metrics_from_a_synthetic_run_dir(tmp_path):
    questions = [_question("streams.s1.optics", "PRIMARY_METHOD_CHANGE"), _question("distance", "RISK_ONLY"),
                 _question("streams.s1.targets", "STATUS_CHANGE"), _question("use_context", "TECHNIQUE_CHANGE")]
    issues = [Issue(check_id="W-WRITER", path="plan", severity="warning",
                    message="writer plan failed (role 'writer' failed: m-mid: output truncated at max_tokens); "
                            "its prose was filled by code")]
    verdicts = [ClaimVerdict(path="a", verdict="supported"), ClaimVerdict(path="b", verdict="partial"),
                ClaimVerdict(path="c", verdict="scope_exceeded")]
    case = tmp_path / "runs" / "full" / "SYN99"
    _write_case(case, _events(questions=questions), _calls(), issues, verdicts)
    m = stored_run_metrics(case)
    assert set(RUN_KEYS) <= set(m)
    assert m["time_to_verdict"] == 3.5 and m["time_to_report"] == 12.25
    assert m["question_value"] == pytest.approx(2 / 3) and m["questions_asked"] == 4      # top 3: one is RISK_ONLY
    assert m["patched"] is True and m["patch_actions"] == 2
    assert m["llm_calls"] == 5 and m["llm_live_calls"] == 4                                # the cached writer is not live
    assert m["tokens_in"] == 1000 + 2000 + 2000 + 800 and m["tokens_out"] == 250 + 1490 + 700 + 60
    assert m["calls_by_role"] == {"extractor": 1, "writer": 3, "judge": 1}
    assert m["tokens_by_model"]["m-mid"] == {"in": 5000, "out": 2440, "cached": 400}
    assert m["writer_out_tokens"] == pytest.approx((1490 + 700) / 2) and m["writer_out_tokens_max"] == 1490
    assert m["writer_tokens_by_section"] == {"answer": 1490, "concept": 700}
    assert aggregate([m, {**m, "writer_tokens_by_section": {"answer": 1290}}])["writer_tokens_by_section"] == \
        {"answer": 1390.0, "concept": 700.0}
    assert m["writer_fallback"] == pytest.approx(1 / 3)                                   # one W-WRITER of three
    assert m["writer_truncation"] == pytest.approx(2 / 3)                                 # failed truncated + at the cap
    assert (m["judge_supported"], m["judge_partial"], m["judge_unsupported"]) == (1, 1, 1)
    assert load_case(case)["report"] is None
    ranked = [_question("a", "STATUS_CHANGE"), _question("b", "STATUS_CHANGE"), _question("c", "TECHNIQUE_CHANGE")]
    (case / "questions.json").write_text(json.dumps(ranked), encoding="utf-8")
    again = stored_run_metrics(case)                       # the gate's full ranking wins over the asked questions
    assert again["question_value"] == 1.0 and again["questions_asked"] == 4


def test_time_falls_back_to_stage_timings_and_refusals_have_no_verdict():
    timings = {"scope": 0.1, "extract": 2.0, "normalise": 0.05, "rules": 0.05, "write": 6.0, "render": 0.1}
    events = [{"type": t, "stage": "x", "payload": {}} for t in ("stage_started", "engine_ready", "run_completed")]
    assert event_times(events, timings) == (2.2, 8.3)
    refused = [{"type": "stage_started", "stage": "scope", "ts": 5.0}, {"type": "run_refused", "stage": "scope",
                                                                        "ts": 5.1}]
    assert event_times(refused, {"scope": 0.1}) == (None, None)
    m = run_metrics(refused, None, [], [])
    assert m["question_value"] is None and m["llm_calls"] is None and m["writer_fallback"] is None
    assert m["patched"] is False


def test_question_value_counts_decision_changing_questions_in_the_top_three():
    assert DECISION_IMPACTS == ("STATUS_CHANGE", "PRIMARY_METHOD_CHANGE", "TECHNIQUE_CHANGE")
    assert question_value([]) is None
    assert question_value([_question("a", "RISK_ONLY")]) == 0.0
    qs = [_question(s, i) for s, i in (("a", "STATUS_CHANGE"), ("b", "TECHNIQUE_CHANGE"), ("c", "RISK_ONLY"),
                                       ("d", "STATUS_CHANGE"))]
    assert question_value(qs) == pytest.approx(2 / 3)
    assert run_metrics([], None, [], [], manifest={"questions": qs[:2]})["question_value"] == 1.0


def test_usage_numbers_accept_every_provider_shape():
    assert usage_numbers({"prompt_tokens": 10, "completion_tokens": 2, "prompt_tokens_details": {"cached_tokens": 4}}) \
        == {"prompt": 10, "completion": 2, "thinking": 0, "cached": 4}
    assert usage_numbers({"input_tokens": 7, "output_tokens": 3, "cache_read_input_tokens": 5})["cached"] == 5
    assert usage_numbers({"prompt_tokens": 9, "completion_tokens": 1, "thinking_tokens": 30, "cached_tokens": 2}) \
        == {"prompt": 9, "completion": 1, "thinking": 30, "cached": 2}
    assert usage_numbers({}) == {"prompt": 0, "completion": 0, "thinking": 0, "cached": 0}
    assert usage_stats([{"role": "writer", "model": "m", "usage": {"completion_tokens": 5}, "finish_reason": "length",
                         "max_tokens": 1500}])["writer_at_cap"] == 1


# ---------------------------------------------------------------- aggregation and statistics

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


def test_aggregate_adds_intervals_percentiles_pooled_verdicts_and_usage():
    rows = [{"trap_handled": i % 4 != 0, "time_to_verdict": float(i), "time_to_report": 10.0 + i,
             "judge_supported": 3, "judge_partial": 1, "judge_unsupported": 0, "llm_calls": 6,
             "calls_by_role": {"writer": 3, "judge": 1}, "tokens_by_model": {"m": {"in": 100, "out": 10, "cached": 0}}}
            for i in range(1, 11)]
    agg = aggregate(rows)
    lo, hi = agg["ci"]["trap_handled"]
    assert lo <= agg["trap_handled"] <= hi and 0.0 <= lo < hi <= 1.0
    assert "latency_s" not in agg["ci"] and "llm_calls" not in agg["ci"]
    assert agg["time_to_verdict_p50"] == 5.5 and agg["time_to_report_p90"] == pytest.approx(19.1)
    assert agg["judge_verdicts"] == 40 and agg["judge_supported_share"] == 0.75
    assert agg["judge_unsupported_share"] == 0.0 and agg["ci"]["judge_supported_share"] == [0.75, 0.75]
    assert agg["calls_by_role"] == {"judge": 1.0, "writer": 3.0}
    assert agg["tokens_by_model"] == {"m": {"in": 100.0, "out": 10.0, "cached": 0.0}}
    assert aggregate(rows) == agg                                     # seeded bootstrap: same rows, same intervals


def test_by_trap_groups_rows():
    rows = [{"trap": "fiber_window", "trap_handled": True, "status_agreement": True},
            {"trap": "fiber_window", "trap_handled": False, "status_agreement": True},
            {"trap": "missing_info", "trap_handled": True}, {"trap": "", "trap_handled": True}]
    out = by_trap(rows)
    assert set(out) == {"fiber_window", "missing_info"}
    assert out["fiber_window"]["n"] == 2 and out["fiber_window"]["trap_handled"] == 0.5
    assert out["missing_info"]["status_agreement"] is None


def test_statistics():
    assert percentile([1, 2, 3, 4], 50) == 2.5 and percentile([None], 50) is None
    assert mean_ci([1, 1, 1]) == (1.0, 1.0) and mean_ci([]) is None
    assert bootstrap([0, 1] * 20, lambda s: sum(s) / len(s)) == bootstrap([0, 1] * 20, lambda s: sum(s) / len(s))
    labels = ("supported", "partial", "unsupported")
    truth = ["supported"] * 6 + ["partial"] * 2 + ["unsupported"] * 2
    assert cohen_kappa(truth, truth, labels) == 1.0
    pred = ["supported"] * 5 + ["partial"] + ["partial", "unsupported"] + ["unsupported"] * 2
    assert confusion(truth, pred, labels) == [[5, 1, 0], [0, 1, 1], [0, 0, 2]]
    po, pe = 0.8, (6 * 5 + 2 * 2 + 2 * 3) / 100
    assert cohen_kappa(truth, pred, labels) == pytest.approx((po - pe) / (1 - pe))
    assert cohen_kappa(truth, pred, labels, "linear") > cohen_kappa(truth, pred, labels)   # near misses count less
    est, lo, hi = ppi_mean([1.0] * 90 + [0.0] * 10, [1.0, 1.0, 0.0, 1.0], [1.0, 0.0, 0.0, 1.0])
    assert est == pytest.approx(0.9 - 0.25) and lo < est < hi


# ---------------------------------------------------------------- the case set

def test_eval_files_do_not_contain_eval_scenarios():
    titles = [(c.case_id, c.title.strip().casefold()) for c in load_eval_cases(MAT)]
    assert len(titles) == 6
    files = [p for p in EVAL_DIR.rglob("*") if p.is_file() and "results" not in p.relative_to(EVAL_DIR).parts
             and "__pycache__" not in p.parts]
    assert files
    leaks = [(p.name, cid) for p in files for cid, title in titles
             if title and title in p.read_text(encoding="utf-8", errors="ignore").casefold()]
    assert leaks == [], f"held-out titles found (case ids only): {leaks}"


def test_case_set_and_gold_fields_are_well_formed(kb):
    cases = load_synthetic_cases()
    gold = load_dev_gold()
    assert len({c["id"] for c in cases}) == len(cases) >= 30
    assert set(gold) == {c.case_id for c in load_dev_cases(MAT)}
    citations = {card.citation() for card in kb.cards.values()}
    every = [(c["id"], c["trap"], c["expect"]) for c in cases] + [(k, g["trap"], g["expect"]) for k, g in gold.items()]
    assert 38 <= len(every) <= 50
    for cid, trap, e in every:
        assert trap in TRAPS, cid
        assert {"scope", "status_any_of", "premise_flag", "screening"} <= set(e) <= EXPECT_KEYS, cid
        scopes = e["scope"] if isinstance(e["scope"], list) else [e["scope"]]
        assert all(s in ScopeLabel.__members__ for s in scopes), cid
        assert all(s in DecisionStatus.__members__ for s in e["status_any_of"]), cid
        if e.get("status"):
            assert e["status"] in e["status_any_of"], cid                     # the expected status is acceptable
        assert all(m in METHODS for m in e.get("methods", [])), cid
        for p in e.get("premises", []):
            assert all(v in PremiseVerdict.__members__ for v in ([p] if isinstance(p, str) else p)), cid
        flagged = [p for p in e.get("premises", []) if set([p] if isinstance(p, str) else p) - {"SUPPORTED"}]
        assert bool(flagged) == bool(e["premise_flag"]) or "premises" not in e, cid
        assert all(c in citations for c in e.get("cite", [])), (cid, e.get("cite"))   # every must-cite page has a card
    traps = [t for _, t, _ in every]
    assert all(traps.count(t) >= 3 for t in BRIEF_TRAPS), {t: traps.count(t) for t in BRIEF_TRAPS}
    by_id = {c["id"]: c for c in cases}
    assert by_id["SYN32"]["expect"]["techniques"] == ["diffuse reflection"]      # evidence-led candidate regression
    assert sum(1 for _, t, e in every if e.get("streams")) >= 3
    rubric = load_rubric()
    assert [c["weight"] for c in rubric["criteria"]] == [30, 20, 15, 15, 10, 10]
    assert all(2 <= len(c["questions"]) <= 4 for c in rubric["criteria"])
    assert "padding" in rubric["judge_prompt"].lower() and "0" in rubric["judge_prompt"]
    yaml.safe_load((EVAL_DIR / "synthetic_cases.yaml").read_text(encoding="utf-8"))


def test_select_cases_attaches_gold_and_traps():
    cases = select_cases("all", MAT)
    assert len(cases) == len(load_synthetic_cases()) + 8
    d01 = next(c for c in cases if c.enquiry.case_id == "D01")
    assert d01.set == "dev" and d01.trap == "control" and d01.expect["methods"] == ["NIR", "Raman"]
    assert all(c.expect is not None and c.trap for c in cases)
    assert [c.enquiry.case_id for c in select_cases("dev", MAT)] == [f"D0{i}" for i in range(1, 9)]


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


# ---------------------------------------------------------------- the runner

def test_run_eval_writes_summary_with_fake_gateway(kb, tmp_path):
    n = 40
    gw = workflow_fake(make_sheet(), n, classifier=[{"label": "IN_SCOPE", "reason": "test"}] * n)
    code = run_eval_main(["--configs", "full,baseline", "--set", "synthetic", "--limit", "2", "--out", str(tmp_path)],
                         gateway=gw, kb=kb, materials=MAT)
    assert code == 0
    (run_dir,) = [p for p in tmp_path.iterdir() if p.is_dir()]
    summary = (run_dir / "summary.md").read_text(encoding="utf-8")
    assert "full" in summary and "baseline" in summary and "trap_handled" in summary
    assert "## Decisions and traps" in summary and "status_agreement" in summary and "## Ablation" in summary
    assert "## Speed and cost per report" in summary and "## By trap category" in summary
    rows = [json.loads(line) for line in (run_dir / "rows.jsonl").read_text(encoding="utf-8").splitlines()]
    assert len(rows) == 4 and all(not r.get("error") for r in rows)
    assert all(r["trap"] and r["profile"] == "fake" for r in rows)
    full = [r for r in rows if r["config"] == "full"]
    assert all(r["llm_calls"] >= 4 and r["calls_by_role"]["writer"] == 3 for r in full)   # extract + 3 writers
    assert all(r["time_to_verdict"] is not None and r["time_to_report"] >= r["time_to_verdict"] for r in full)
    assert all(r["direct_answer_consistent"] is not None for r in rows)
    case_dir = run_dir / "runs" / "full" / "SYN01"
    assert {"events.jsonl", "manifest.json", "report.json", "verification.json", "calls.json", "judge.json",
            "questions.json"} <= {p.name for p in case_dir.iterdir()}
    ranked = json.loads((case_dir / "questions.json").read_text(encoding="utf-8"))
    assert all(ClarifyQuestion.model_validate(q) for q in ranked)
    assert rows[0]["question_value"] == question_value(ranked)
    assert stored_run_metrics(case_dir)["time_to_report"] == rows[0]["time_to_report"]
    data = json.loads((run_dir / "summary.json").read_text(encoding="utf-8"))
    assert data["by_trap"]["full"] and "ci" in data["configs"]["full"]


def test_summarize_and_publish_rerender_without_a_model(kb, tmp_path):
    gw = workflow_fake(make_sheet(), 4, classifier=[{"label": "IN_SCOPE", "reason": "test"}] * 4)
    assert run_eval_main(["--configs", "full", "--set", "dev", "--limit", "1", "--out", str(tmp_path)],
                         gateway=gw, kb=kb, materials=MAT) == 0
    (run_dir,) = [p for p in tmp_path.iterdir() if p.is_dir()]
    (run_dir / "summary.md").unlink()
    target = tmp_path / "EVAL_RESULTS.md"
    assert run_eval_main(["--summarize", str(run_dir), "--publish", str(target)]) == 0
    text = target.read_text(encoding="utf-8")
    assert text.startswith("<!-- Generated by eval/run_eval.py --configs full --set dev")
    assert "H01-H06 are never evaluated here" in text and "# PRISM evaluation" in text
    assert (run_dir / "summary.md").exists()


def test_run_eval_refuses_beyond_the_request_budget(kb, tmp_path, capsys):
    from prism.llm.budget import BudgetMeter
    gw = workflow_fake(make_sheet(), 1)
    gw.budget = BudgetMeter({"day": 10})
    assert run_eval_main(["--configs", "full", "--set", "dev", "--out", str(tmp_path)], gateway=gw, kb=kb,
                         materials=MAT) == 2
    assert "--offset/--limit" in capsys.readouterr().err and not any(tmp_path.iterdir())


def test_resume_finishes_a_split_run_in_the_same_directory(kb, tmp_path):
    gw = workflow_fake(make_sheet(), 6, classifier=[{"label": "IN_SCOPE", "reason": "test"}] * 6)
    assert run_eval_main(["--configs", "full", "--set", "dev", "--limit", "1", "--out", str(tmp_path)],
                         gateway=gw, kb=kb, materials=MAT) == 0
    (run_dir,) = [p for p in tmp_path.iterdir() if p.is_dir()]
    with (run_dir / "rows.jsonl").open("a", encoding="utf-8") as fh:     # a failed run is tried again
        fh.write(json.dumps({"config": "full", "set": "dev", "case_id": "D02", "error": "RateLimited"}) + "\n")
    before = len(gw.requests)
    assert run_eval_main(["--configs", "full", "--set", "dev", "--limit", "3", "--resume", str(run_dir)],
                         gateway=gw, kb=kb, materials=MAT) == 0
    rows = [json.loads(line) for line in (run_dir / "rows.jsonl").read_text(encoding="utf-8").splitlines()]
    assert [r["case_id"] for r in rows] == ["D01", "D02", "D03"] and not any(r.get("error") for r in rows)
    assert sum(1 for r in gw.requests[before:] if r["role"] == "extractor") == 2       # D01 is not run again
    summary = json.loads((run_dir / "summary.json").read_text(encoding="utf-8"))
    assert summary["configs"]["full"]["n"] == 3 and summary["cases"] == ["D01", "D02", "D03"]
