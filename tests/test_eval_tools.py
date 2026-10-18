"""The accuracy-loop tools: call recorder, judged-sentence export, judge agreement, few-shot examples, bake-off and
costs. Synthetic run dirs and FakeGateway only, no network."""
from __future__ import annotations

import csv
import importlib.util
import json
from dataclasses import replace
from pathlib import Path

import pytest
import yaml

from eval.claims import COLUMNS, claim_id, collect, merge, read_csv, sample, write_csv
from eval.costs import cost, load_prices
from eval.recorder import RecordingGateway, judged_sentences, parse_judge_prompt
from eval.run_eval import Case, evaluate
from eval.rundir import case_dirs, latest_run, load_case
from prism.cases import sha256_text
from prism.llm.gateway import LLMResult, LLMUnavailable
from prism.llm.profiles import Profile, RoleConfig
from prism.llm.prompts import render
from prism.schemas import ClaimVerdict, Enquiry
from prism.stages.verify import JudgeResult, load_judge_examples
from tests.factories import make_sheet
from tests.fakes import AnswerSection, FakeGateway, judged_answer, workflow_fake

ROOT = Path(__file__).resolve().parents[1]
MAT = ROOT / "materials"
DAIRY = {"matrix": "liquid", "optics": "opaque", "domain": "dairy_food", "targets": ("fat", "protein")}
TEXT = "We need to monitor fat and protein in an opaque liquid dairy stream with a fiber probe. What should we test?"


def _script(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


export_claims = _script("export_claims")
judge_agreement = _script("judge_agreement")
build_judge_examples = _script("build_judge_examples")
bakeoff = _script("bakeoff")


def _case(cid="W1", text=TEXT) -> Case:
    return Case("synthetic", Enquiry(case_id=cid, title="", text=text, sha256=sha256_text(text)),
                {"scope": "IN_SCOPE", "status_any_of": ["PROVISIONAL"], "premise_flag": False, "screening": False,
                 "status": "PROVISIONAL", "methods": ["NIR"], "cite": ["S01 p.17"]}, "control")


# ---------------------------------------------------------------- recorder

def test_parse_judge_prompt_reads_back_the_rendered_claims():
    claims = [{"id": "c1", "path": "p", "text": 'NIR "reflection" suits | opaque dairy.',
               "quotes": ["[S01-p17-nir-reflection-opaque | process_application] Inline NIR | Reflection",
                          "[TABLE-nir_diffuse_reflection_probe | method_general] NIR | diffuse reflection probe"]},
              {"id": "c2", "path": "q", "text": "Second claim.", "quotes": []}]
    examples = [{"claim": "Claims:\n- c9: fake", "quotes": ["[X-1 | lab_study] q"], "verdict": "partial", "reason": ""}]
    prompt, _ = render("judge.j2", claims=claims, examples=examples)
    parsed = parse_judge_prompt(prompt)
    assert [p["cid"] for p in parsed] == ["c1", "c2"]
    assert parsed[0]["text"] == claims[0]["text"]
    assert parsed[0]["ids"] == ["S01-p17-nir-reflection-opaque", "TABLE-nir_diffuse_reflection_probe"]
    assert parsed[1]["ids"] == [] and parse_judge_prompt("no claims here") == []


class _Inner:
    profile = Profile("p", "fake", "", "X", roles={"writer": RoleConfig(models=["m"], max_tokens=1500)})

    def __init__(self):
        self.n = 0

    def complete(self, role, messages, schema=None, reasoning=None, max_tokens=None, tools=None):
        self.n += 1
        if role == "patcher":
            raise LLMUnavailable("down")
        if schema is JudgeResult:
            parsed = JudgeResult.model_validate({"verdicts": [{"id": "c1", "verdict": "scope_exceeded",
                                                               "reason": "lab"}]})
            return LLMResult(parsed.model_dump_json(), "judge-m", parsed, {"prompt_tokens": 50})
        return LLMResult("ok", "m", None, {"prompt_tokens": 100, "completion_tokens": 1480}, 0.5, False)


def test_recording_gateway_records_usage_caps_errors_and_judge_claims(kb):
    inner = _Inner()
    gw = RecordingGateway(inner)
    gw.complete("writer", [{"role": "user", "content": "x"}])
    with pytest.raises(LLMUnavailable):
        gw.complete("patcher", [{"role": "user", "content": "x"}])
    claims = [{"id": "c1", "path": "p", "text": "Claim.", "quotes": ["[S01-p17-nir-reflection-opaque | x] q"]}]
    prompt, _ = render("judge.j2", claims=claims, examples=[])
    gw.complete("judge", [{"role": "user", "content": prompt}], schema=JudgeResult)
    assert gw.profile is inner.profile                                    # attributes pass through
    calls = gw.take()
    assert gw.take() == []
    assert calls[0]["max_tokens"] == 1500 and calls[0]["usage"]["completion_tokens"] == 1480
    assert calls[1] == {**calls[1], "role": "patcher", "error": "LLMUnavailable"}
    judged = judged_sentences(calls, [ClaimVerdict(path="recommendations[0].rationale[0]", verdict="unsupported")],
                              kb.cards)
    assert judged == [{"cid": "c1", "path": "recommendations[0].rationale[0]", "text": "Claim.", "claim_type": "AFS",
                       "ids": ["S01-p17-nir-reflection-opaque"],
                       "quotes": [{"id": "S01-p17-nir-reflection-opaque", "citation": "S01 p.17",
                                   "scope": "process_application",
                                   "quote": kb.cards["S01-p17-nir-reflection-opaque"].quote}],
                       "verdict": "unsupported", "reason": "lab"}]


# ---------------------------------------------------------------- export (from a real fake run and a synthetic one)

def _judged_run(kb, tmp_path) -> Path:
    sheet = make_sheet(**DAIRY)
    gw = workflow_fake(sheet, sections={AnswerSection: judged_answer(kb, sheet)},
                       judge={"verdicts": [{"id": "c1", "verdict": "partial", "reason": "wider than the quote"}]},
                       patcher=[{"patches": []}] * 2)
    run_dir = tmp_path / "20260101T000000Z"
    run_dir.mkdir()
    rows = evaluate([_case()], ["full"], gw, kb, MAT, run_dir, log=lambda _: None)
    assert not rows[0].get("error") and rows[0]["judge_partial"] == 1
    return run_dir


def test_a_judged_run_exports_its_sentences_with_quotes_and_pages(kb, tmp_path):
    run_dir = _judged_run(kb, tmp_path)
    assert latest_run(tmp_path) == run_dir and [c for c, _, _ in case_dirs(run_dir)] == ["full"]
    judged = load_case(run_dir / "runs" / "full" / "W1")["judge"]
    assert len(judged) == 1 and judged[0]["path"].startswith("recommendations[0].rationale")
    assert judged[0]["verdict"] == "partial" and judged[0]["quotes"][0]["citation"].startswith("S01")
    out = tmp_path / "to_label.csv"
    assert export_claims.main([str(run_dir), "--out", str(out)]) == 0
    rows = read_csv(out)
    assert len(rows) == 1 and rows[0]["case"] == "W1" and rows[0]["judge_verdict"] == "partial"
    assert rows[0]["claim_type"] == "AFS" and rows[0]["quotes"].startswith("S01") and rows[0]["label"] == ""
    assert rows[0]["id"] == claim_id("W1", judged[0]["text"], judged[0]["ids"])
    with out.open(encoding="utf-8", newline="") as fh:
        assert next(csv.reader(fh)) == list(COLUMNS)


def _synthetic_run(root: Path, sentences: dict[str, list[tuple[str, str]]]) -> Path:
    run_dir = root / "20260202T000000Z"
    for case, items in sentences.items():
        d = run_dir / "runs" / "full" / case
        d.mkdir(parents=True)
        (d / "judge.json").write_text(json.dumps([
            {"cid": f"c{i}", "path": f"decision_basis[{i}]", "text": text, "claim_type": "AFS",
             "ids": ["S01-p10-nir-range"], "verdict": verdict, "reason": "",
             "quotes": [{"id": "S01-p10-nir-range", "citation": "S01 p.10", "scope": "method_general", "quote": "q"}]}
            for i, (text, verdict) in enumerate(items)]), encoding="utf-8")
    return run_dir


def test_reexport_keeps_labels_and_sampling_spreads_over_verdicts(tmp_path):
    items = [(f"Supported claim {i}.", "supported") for i in range(8)] + [("Partial claim.", "partial"),
                                                                           ("Unsupported claim.", "unsupported")]
    run_dir = _synthetic_run(tmp_path, {"SYN90": items, "SYN91": [("Supported claim 0.", "supported")]})
    rows = collect(run_dir)
    assert len(rows) == 11                                     # same sentence in another case is another row
    picked = sample(rows, 4)
    assert {r["judge_verdict"] for r in picked} == {"supported", "partial", "unsupported"} and len(picked) == 4
    assert sample(rows, 4) == picked                           # deterministic
    out = tmp_path / "to_label.csv"
    export_claims.export(run_dir, out, limit=3)
    labelled = read_csv(out)
    labelled[0]["label"], labelled[0]["note"] = "supported", "same strength"
    write_csv(labelled, out)
    stats = export_claims.export(run_dir, out)
    again = read_csv(out)
    assert stats["new"] == 8 and len(again) == 11
    assert again[0]["label"] == "supported" and again[0]["note"] == "same strength"
    assert merge([], again) == again


# ---------------------------------------------------------------- agreement and few-shot examples

def _labelled_rows():
    def row(i, label, judge, note="", sentence=None, ids="S01-p17-nir-reflection-opaque"):
        return {"id": f"C-{i:04d}", "case": "SYN90", "config": "full", "path": f"p{i}", "claim_type": "AFS",
                "sentence": sentence or f"Sentence number {i}.", "quotes": "S01 p.17 [process_application] x: “q”",
                "card_ids": ids, "judge_verdict": judge, "judge_reason": "", "label": label, "note": note, "run": "r"}
    rows = [row(i, "supported", "supported") for i in range(6)]
    rows += [row(6, "supported", "partial"), row(7, "partial", "partial", "lab result stretched to the process"),
             row(8, "partial", "supported"), row(9, "unsupported", "unsupported"), row(10, "unsupported", "partial"),
             row(11, "Partial ", "partial"), row(12, "", "supported"), row(13, "", "unsupported"),
             row(14, "unsupported", "unsupported", sentence="x" * 300)]
    return rows


def test_judge_agreement_reports_accuracy_kappa_and_confusion(tmp_path):
    rows = _labelled_rows()
    result = judge_agreement.agreement(rows)
    three = result["three_level"]
    assert result["labelled"] == 13 and three["n"] == 13
    assert three["labels"] == ["supported", "partial", "unsupported"]
    assert three["confusion"] == [[6, 1, 0], [1, 2, 0], [0, 1, 2]]
    assert three["accuracy"] == pytest.approx(10 / 13, abs=1e-3)
    lo, hi = three["accuracy_ci"]
    assert lo <= three["accuracy"] <= hi
    assert 0 < three["kappa"] < three["kappa_linear"] < 1
    assert result["binary"]["confusion"] == [[6, 1], [1, 5]]
    rate = result["support_rate"]
    assert rate["unlabelled"] == 2 and len(rate["ppi"]) == 3
    path = tmp_path / "to_label.csv"
    write_csv(rows, path)
    out = tmp_path / "agreement.md"
    assert judge_agreement.main([str(path), "--out", str(out)]) == 0
    text = out.read_text(encoding="utf-8")
    assert "Confusion matrix" in text and "kappa" in text and "Prediction-powered" in text
    assert "No labelled rows" in judge_agreement.markdown(judge_agreement.agreement([]), "x")


def test_judge_examples_are_balanced_short_and_load_into_the_judge_prompt(kb, tmp_path):
    examples = build_judge_examples.build(_labelled_rows(), kb.cards, per_label=4)
    labels = [e["verdict"] for e in examples]
    assert labels.count("supported") == labels.count("partial") == labels.count("unsupported") == 2
    sup = [e for e in examples if e["verdict"] == "supported"]
    assert sup[0]["source_id"] == "C-0006"                     # the judge's mistake comes first
    part = [e for e in examples if e["verdict"] == "partial"]
    assert {e["source_id"] for e in part} == {"C-0008", "C-0007"}
    assert all(len(e["claim"]) <= 240 for e in examples)       # the 300-character sentence is left out
    assert examples[0]["quotes"][0].startswith("[S01-p17-nir-reflection-opaque | process_application] ")
    assert next(e for e in part if e["source_id"] == "C-0007")["reason"] == "lab result stretched to the process"
    out = tmp_path / "judge_examples.yaml"
    build_judge_examples.write(examples, out)
    assert out.read_text(encoding="utf-8").startswith("# Few-shot examples")
    loaded = load_judge_examples(replace(kb, root=tmp_path))
    assert [e["verdict"] for e in loaded] == labels
    prompt, _ = render("judge.j2", claims=[], examples=loaded)
    assert "Examples:" in prompt and examples[0]["claim"] in prompt
    unbalanced = build_judge_examples.build(_labelled_rows(), kb.cards, per_label=4, balanced=False)
    assert [e["verdict"] for e in unbalanced].count("supported") == 4


def test_the_shipped_judge_examples_file_is_an_empty_template(kb):
    path = ROOT / "kb" / "judge_examples.yaml"
    assert path.exists() and yaml.safe_load(path.read_text(encoding="utf-8")) == []
    assert "verdict: supported | partial | unsupported" in path.read_text(encoding="utf-8")
    assert load_judge_examples(kb) == []


# ---------------------------------------------------------------- bake-off and costs

def test_costs_need_every_price():
    prices = {"currency": "EUR", "models": {"a": {"input": 1.0, "output": 2.0, "cached_input": 0.25},
                                            "b": {"input": None, "output": 1.0}}}
    tokens = {"a": {"in": 1_000_000, "out": 500_000, "cached": 400_000}}
    assert cost(tokens, prices) == pytest.approx(0.6 + 0.1 + 1.0)
    assert cost({**tokens, "b": {"in": 10, "out": 1, "cached": 0}}, prices) is None
    assert cost({"models/a": {"in": 1_000_000, "out": 0}}, prices) == pytest.approx(1.0)
    assert cost({"c": {"in": 0, "out": 0}}, prices) is None              # no usage recorded: unknown, not free
    shipped = load_prices()                       # a price is a positive number or null (unknown), never a guess of 0
    assert shipped["models"] and all(v.get(k) is None or v[k] > 0
                                     for v in shipped["models"].values() for k in ("input", "output"))
    assert shipped["models"]["gpt-6.1-sol"]["input"] is None                 # no published price


def test_bakeoff_runs_each_profile_and_writes_the_report(kb, tmp_path):
    from prism.llm.budget import BudgetMeter

    def factory(profile):
        if profile == "broken":
            raise KeyError("no such profile")
        gw = workflow_fake(make_sheet(**DAIRY), 4, classifier=[{"label": "IN_SCOPE", "reason": "t"}] * 4)
        if profile == "tiny":
            gw.budget = BudgetMeter({"day": 3})
        return gw

    def bench(profile, parallel):
        return {"runs": [{"model": f"{profile}-writer", "ttft_s": 0.4, "total_s": 3.1, "out_tokens": 400,
                          "decode_tok_s": 150.0}, {"parallel": parallel, "wall_s": 3.5}]}

    prices = tmp_path / "prices.yaml"
    prices.write_text("currency: EUR\nmodels: {}\n", encoding="utf-8")
    out = tmp_path / "BAKEOFF.md"
    code = bakeoff.main(["--profiles", "gwdg", "gemini", "broken", "tiny", "--set", "dev", "--limit", "1",
                         "--prices", str(prices), "--out", str(out)], gateway_factory=factory, bench=bench, kb=kb,
                        materials=MAT, results=tmp_path / "results")
    assert code == 0
    text = out.read_text(encoding="utf-8")
    assert "| Metric | gwdg | gemini |" in text and "## Quality (`full`)" in text and "trap_handled" in text
    assert "time_to_report_p90" in text and "| cost | — | — |" in text
    assert "gwdg-writer" in text and "3 parallel calls" in text
    assert "`broken` skipped: profile not usable" in text and "`tiny` skipped: request budget" in text
    assert "config/prices.yaml" in text
    assert len([p for p in (tmp_path / "results").iterdir() if p.is_dir()]) == 2


def test_bakeoff_cost_column_uses_the_price_table():
    agg = {"n": 2, "errors": 0, "llm_calls": 6, "tokens_in": 30000.0, "tokens_out": 3000.0, "ci": {},
           "tokens_by_model": {"m-mid": {"in": 20000.0, "out": 2500.0, "cached": 0.0},
                               "m-fast": {"in": 10000.0, "out": 500.0, "cached": 0.0}}}
    results = [{"profile": "p1", "run_dir": "/x", "summary": {"configs": {"full": agg}}}]
    meta = {"profiles": ["p1"], "set": "dev", "configs": ["full"], "cases": 2, "date": "2026-10-18"}
    prices = {"currency": "EUR", "models": {"m-mid": {"input": 0.1, "output": 0.4}, "m-fast": {"input": 0.05,
                                                                                         "output": 0.2}}}
    text = bakeoff.markdown(results, meta, prices)
    assert "| cost | 0.0036 EUR |" in text                     # (20000·0.1 + 2500·0.4 + 10000·0.05 + 500·0.2) / 1e6
    assert "| cost | — |" in bakeoff.markdown(results, meta, {"currency": "", "models": {}})


def test_bakeoff_skips_a_profile_without_its_key(kb, tmp_path, monkeypatch):
    monkeypatch.delenv("PRISM_TEST_KEY", raising=False)
    gw = FakeGateway()
    gw.profile = Profile("p", "openai_compatible", "", "PRISM_TEST_KEY")
    result = bakeoff.run_profile("p", [_case()], ["full"], kb, MAT, tmp_path, -1, gateway_factory=lambda _: gw)
    assert result["skipped"] == "API key variable PRISM_TEST_KEY is not set" and gw.requests == []
