"""Evaluate PRISM on development data and run the ablation (never the held-out evaluation set).

Usage: .venv/bin/python eval/run_eval.py [--configs full,rules_verify,rules_only,baseline]
                                         [--set dev|synthetic|all] [--judge] [--offset N] [--limit N]
                                         [--out eval/results | --resume eval/results/<stamp>]
                                         [--publish [docs/EVAL_RESULTS.md]]
       .venv/bin/python eval/run_eval.py --summarize eval/results/<stamp> [--publish]     (re-aggregates, no model call)
Writes eval/results/<timestamp>/{rows.jsonl, summary.json, summary.md, ablation.png, runs/<config>/<case>/...}. The
per-case artefacts (eval/rundir.py) feed the claim-set export. The PNG needs matplotlib and is skipped without it.

Sets: `dev` = D01–D08 from the examples document, `synthetic` = eval/synthetic_cases.yaml, `all` = both. Every case
carries gold fields (eval/dev_gold.yaml for D01–D08). Cost: about CALLS_BY_CONFIG[config] LLM requests per case.
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

if __package__ in (None, ""):                          # run as a script: make `eval` and `prism` importable
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import yaml
from jinja2 import Environment, StrictUndefined
from pydantic import BaseModel, Field

from eval.metrics import (
    GOLD_KEYS,
    METRIC_KEYS,
    RUN_KEYS,
    TIME_KEYS,
    VERDICT_KEYS,
    aggregate,
    by_trap,
    case_metrics,
)
from eval.recorder import RecordingGateway, judged_sentences
from eval.rundir import RUNS, save_case
from prism.cases import load_dev_cases, sha256_text
from prism.orchestrator import Pipeline, PipelineFlags
from prism.schemas import Enquiry

EVAL_DIR = Path(__file__).resolve().parent
ROOT = EVAL_DIR.parent
SYNTHETIC = EVAL_DIR / "synthetic_cases.yaml"
DEV_GOLD = EVAL_DIR / "dev_gold.yaml"
RUBRIC = EVAL_DIR / "rubric.yaml"
EVAL_RESULTS = ROOT / "docs" / "EVAL_RESULTS.md"
# LLM requests per case, upper bound: extraction, three writers, judge, patch and the query embedding (hybrid).
CALLS_BY_CONFIG = {"full": 7, "rules_verify": 6, "rules_only": 5, "baseline": 4}
CONFIGS = {
    "full": lambda: PipelineFlags(),
    "rules_verify": lambda: PipelineFlags(repair=False),
    "rules_only": lambda: PipelineFlags(verify=False),
    "baseline": lambda: PipelineFlags(rules=False, verify=False, repair=False, retrieval="bm25"),
}
TRAPS = ("missing_info", "out_of_source", "contradicted_premise", "multi_stream", "aqueous_fluorescence",
         "fiber_window", "calibration_transfer", "evidence_scope", "off_topic", "control")
ABLATION_ORDER = ("baseline", "rules_only", "rules_verify", "full")
PLOT_METRICS = (("trap_handled", "Trap handling (share)"), ("claim_support", "Claim support (share)"),
                ("invented_numbers", "Invented numbers (per case)"))
ABLATION_NOTE = (
    "`baseline` switches the rules, the support judge and patching off and retrieves with BM25 only. The report "
    "skeleton (recommendations, measurement concept, plan) is still built by code from the engine's candidates, so "
    "the baseline is stronger than a model writing alone and the gap to `full` understates what the rules add. "
    "Without rules nothing is blocked and the status stays provisional, which is what the trap and status columns "
    "measure.")
QUESTION_NOTE = ("`question_value` = share of the clarify gate's top 3 ranked questions whose options can change the "
                 "status, the primary method or the probe technique; `questions_asked` = questions put to the "
                 "scientist at `engine_ready`.")
_jinja = Environment(undefined=StrictUndefined, trim_blocks=True, lstrip_blocks=True)


@dataclass
class Case:
    set: str
    enquiry: Enquiry
    expect: dict | None
    trap: str = ""


# ---------------------------------------------------------------- inputs

def load_synthetic_cases(path: Path = SYNTHETIC) -> list[dict]:
    return yaml.safe_load(Path(path).read_text(encoding="utf-8"))


def load_dev_gold(path: Path = DEV_GOLD) -> dict[str, dict]:
    """Gold fields of the development cases D01–D08 (their text stays in the examples document)."""
    if not Path(path).exists():
        return {}
    return {c["id"]: c for c in yaml.safe_load(Path(path).read_text(encoding="utf-8")) or []}


def load_rubric(path: Path = RUBRIC) -> dict:
    return yaml.safe_load(Path(path).read_text(encoding="utf-8"))


def select_cases(case_set: str, materials: Path) -> list[Case]:
    """The development and/or synthetic cases with their gold fields."""
    out: list[Case] = []
    if case_set in ("dev", "all"):
        gold = load_dev_gold()
        for e in load_dev_cases(Path(materials)):
            g = gold.get(e.case_id, {})
            out.append(Case("dev", e, g.get("expect"), g.get("trap", "")))
    if case_set in ("synthetic", "all"):
        for c in load_synthetic_cases():
            text = c["text"].strip()
            out.append(Case("synthetic", Enquiry(case_id=c["id"], title="", text=text, sha256=sha256_text(text),
                                                 origin="case_file"), c["expect"], c.get("trap", "")))
    return out


def expected_calls(configs: list[str], n_cases: int, judge: bool = False) -> int:
    return sum(CALLS_BY_CONFIG[c] + (1 if judge else 0) for c in configs) * n_cases


# ---------------------------------------------------------------- LLM judge (rubric)

class JudgeScore(BaseModel):
    question_id: str
    score: int = Field(ge=0, le=4)
    reason: str = ""


class JudgeResult(BaseModel):
    scores: list[JudgeScore] = Field(default_factory=list)
    padding: list[str] = Field(default_factory=list)


def judge_report(enquiry_text: str, markdown: str, rubric: dict, gateway) -> dict:
    """Score one report with the critic role; returns weighted criterion scores and a 0–100 total."""
    prompt = _jinja.from_string(rubric["judge_prompt"]).render(criteria=rubric["criteria"], enquiry=enquiry_text,
                                                               report=markdown)
    result: JudgeResult = gateway.complete("critic", [{"role": "user", "content": prompt}], schema=JudgeResult).parsed
    given = {s.question_id: s.score for s in result.scores}
    criteria = {}
    for c in rubric["criteria"]:
        subs = [given.get(q["id"], 0) for q in c["questions"]]       # a skipped sub-question scores 0
        criteria[c["id"]] = round(c["weight"] * sum(subs) / (4 * len(subs)), 2)
    return {"total": round(sum(criteria.values()), 2), "criteria": criteria, "padding": result.padding}


# ---------------------------------------------------------------- outputs

def _fmt(value) -> str:
    if value is None:
        return "—"
    return f"{value:.3f}".rstrip("0").rstrip(".") if isinstance(value, float) else str(value)


def _cell(agg: dict, key: str) -> str:
    ci = (agg.get("ci") or {}).get(key)
    return _fmt(agg.get(key)) + (f" [{_fmt(ci[0])}–{_fmt(ci[1])}]" if ci and agg.get(key) is not None else "")


def _table(title: str, keys: list[str], summary: dict, note: str = "") -> list[str]:
    configs = list(summary["configs"])
    keys = [k for k in keys if any(summary["configs"][c].get(k) is not None for c in configs)]
    if not keys:
        return []
    lines = ["", f"## {title}", ""] + ([note, ""] if note else [])
    lines += ["| Config | " + " | ".join(keys) + " |", "|---|" + "---|" * len(keys)]
    for cfg in configs:
        agg = summary["configs"][cfg]
        lines.append(f"| {cfg} | " + " | ".join(_cell(agg, k) for k in keys) + " |")
    return lines


def _speed_table(summary: dict) -> list[str]:
    configs = list(summary["configs"])
    if not any(summary["configs"][c].get(k) is not None for c in configs for k in (*TIME_KEYS, "llm_calls")):
        return []
    note = ("Times in seconds from the first event: verdict = `engine_ready` (end of prepare), report = "
            "`run_completed`. Tokens include thinking tokens; cached responses count with their recorded usage.")
    head = ("| Config | time_to_verdict p50 / p90 | time_to_report p50 / p90 | latency_s | llm_calls | llm_live_calls "
            "| tokens_in | tokens_out |")
    lines = ["", "## Speed and cost per report", "", note, "", head, "|---|---|---|---|---|---|---|---|"]
    for cfg in configs:
        a = summary["configs"][cfg]
        lines.append(f"| {cfg} | {_fmt(a.get('time_to_verdict_p50'))} / {_fmt(a.get('time_to_verdict_p90'))} | "
                     f"{_fmt(a.get('time_to_report_p50'))} / {_fmt(a.get('time_to_report_p90'))} | "
                     f"{_fmt(a.get('latency_s'))} | {_fmt(a.get('llm_calls'))} | {_fmt(a.get('llm_live_calls'))} | "
                     f"{_fmt(a.get('tokens_in'))} | {_fmt(a.get('tokens_out'))} |")
    roles = sorted({r for c in configs for r in (summary["configs"][c].get("calls_by_role") or {})})
    if roles:
        lines += ["", "Calls per report by role:", "", "| Config | " + " | ".join(roles) + " |",
                  "|---|" + "---|" * len(roles)]
        for cfg in configs:
            per = summary["configs"][cfg].get("calls_by_role") or {}
            lines.append(f"| {cfg} | " + " | ".join(_fmt(per.get(r)) for r in roles) + " |")
    return lines


def _verification_table(summary: dict) -> list[str]:
    configs = list(summary["configs"])
    keys = ["judge_verdicts", *(f"{k}_share" for k in VERDICT_KEYS), "patched", "patch_actions", "writer_fallback",
            "writer_truncation", "writer_out_tokens", "writer_out_tokens_max"]
    keys = [k for k in keys if any(summary["configs"][c].get(k) is not None for c in configs)]
    if not keys:
        return []
    note = ("Judge verdicts are pooled over all judged sentences. `patched` = share of runs whose patch stage ran; "
            "`writer_fallback` = share of the three writer sections filled by code after the writer failed (W-WRITER); "
            "`writer_truncation` = share of writer sections cut off at max_tokens.")
    lines = ["", "## Verification and writers", "", note, "",
             "| Config | " + " | ".join(keys) + " |", "|---|" + "---|" * len(keys)]
    for cfg in configs:
        agg = summary["configs"][cfg]
        lines.append(f"| {cfg} | " + " | ".join(_cell(agg, k) for k in keys) + " |")
    sections = sorted({s for c in configs for s in (summary["configs"][c].get("writer_tokens_by_section") or {})})
    if sections:
        lines += ["", "Writer output tokens per section (mean over reports):", "",
                  "| Config | " + " | ".join(sections) + " |", "|---|" + "---|" * len(sections)]
        for cfg in configs:
            per = summary["configs"][cfg].get("writer_tokens_by_section") or {}
            lines.append(f"| {cfg} | " + " | ".join(_fmt(per.get(s)) for s in sections) + " |")
    return lines


def _trap_table(summary: dict) -> list[str]:
    traps = summary.get("by_trap") or {}
    if not any(traps.values()):
        return []
    keys = ("trap_handled", "status_agreement", "method_agreement", "premise_agreement", "cite_recall")
    lines = ["", "## By trap category", "", "| Trap | Config | n | " + " | ".join(keys) + " |",
             "|---|---|---|" + "---|" * len(keys)]
    names = sorted({t for per in traps.values() for t in per}, key=lambda t: (TRAPS.index(t) if t in TRAPS else 99, t))
    for trap in names:
        for cfg, per in traps.items():
            if trap in per:
                lines.append(f"| {trap} | {cfg} | {per[trap]['n']} | " + " | ".join(_cell(per[trap], k) for k in keys)
                             + " |")
    return lines


def summary_markdown(summary: dict, rows: list[dict]) -> str:
    configs = list(summary["configs"])
    profile = f" · profile: {summary['profile']}" if summary.get("profile") else ""
    lines = ["# PRISM evaluation", "",
             f"Set: `{summary['set']}` · cases: {len(summary['cases'])}{profile} · started: {summary['started_at']}",
             "", ("Shares are means over the cases where a metric applies (— = not applicable); brackets give the "
                  "bootstrap 95 % confidence interval over cases. `invented_numbers` is the mean count per case."),
             "", "| Config | n | errors |", "|---|---|---|"]
    lines += [f"| {c} | {summary['configs'][c]['n']} | {summary['configs'][c]['errors']} |" for c in configs]
    lines += _table("Decisions and traps", ["trap_handled", "status_agreement", "method_agreement",
                                            "technique_agreement", "premise_agreement", "scope_ok", "screening_ok",
                                            "streams_ok"], summary)
    lines += _table("Grounding", ["citation_existence", "quote_fidelity", "claim_support", "invented_numbers",
                                  "invented_numbers_total", "fact_fidelity", "cite_recall"], summary)
    lines += _table("Report", ["schema_ok", "plan_ok", "questions_ok", "direct_answer_consistent", "question_value",
                               "questions_asked", "judge_score"], summary,
                    note=QUESTION_NOTE)
    lines += _speed_table(summary)
    lines += _verification_table(summary)
    lines += _trap_table(summary)
    with_gold = [r for r in rows if r.get("trap_handled") is not None or r.get("trap")]
    if with_gold:
        ids = list(dict.fromkeys(r["case_id"] for r in with_gold))
        cell = {(r["config"], r["case_id"]): r for r in rows}
        trap_of = {r["case_id"]: r.get("trap", "") for r in with_gold}
        lines += ["", "## Trap handling per case", "",
                  "| Case | Trap | " + " | ".join(configs) + " |", "|---|---|" + "---|" * len(configs)]
        for cid in ids:
            marks = []
            for cfg in configs:
                r = cell.get((cfg, cid), {})
                ok = r.get("trap_handled")
                marks.append("—" if ok is None else f"{'✅' if ok else '❌'} {r.get('status') or r.get('scope')}")
            lines.append(f"| {cid} | {trap_of.get(cid) or '—'} | " + " | ".join(marks) + " |")
    if "baseline" in configs:
        lines += ["", "## Ablation", "", ABLATION_NOTE]
    errors = [r for r in rows if r.get("error")]
    if errors:
        lines += ["", "## Errors", ""] + [f"- {r['config']} {r['case_id']}: {r['error']}" for r in errors]
    return "\n".join(lines) + "\n"


def ablation_png(summary: dict, path: Path) -> bool:
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return False
    configs = [c for c in ABLATION_ORDER if c in summary["configs"]]
    if not configs:
        return False
    colours = {"baseline": "#001070", "rules_only": "#0040C0", "rules_verify": "#0050E0", "full": "#00E5FF"}
    fig, axes = plt.subplots(1, len(PLOT_METRICS), figsize=(4 * len(PLOT_METRICS), 3.6))
    for ax, (key, title) in zip(axes, PLOT_METRICS, strict=True):
        values = [summary["configs"][c].get(key) or 0.0 for c in configs]
        ax.bar(configs, values, color=[colours[c] for c in configs])
        ax.set_title(title, fontsize=10)
        ax.tick_params(axis="x", rotation=30, labelsize=8)
        if key != "invented_numbers":
            ax.set_ylim(0, 1)
    fig.suptitle(f"PRISM ablation ({summary['set']} set, {len(summary['cases'])} cases)", fontsize=11)
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return True


def new_run_dir(root: Path) -> Path:
    """A fresh, timestamped directory for one evaluation run."""
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    path, i = Path(root) / stamp, 1
    while path.exists():
        path, i = Path(root) / f"{stamp}-{i}", i + 1
    path.mkdir(parents=True)
    return path


def build_summary(rows: list[dict], meta: dict) -> dict:
    configs = list(dict.fromkeys(r["config"] for r in rows)) or list(meta.get("configs", []))
    return {"started_at": meta.get("started_at", ""), "set": meta.get("set", ""), "profile": meta.get("profile", ""),
            "cases": list(dict.fromkeys(r["case_id"] for r in rows)) or list(meta.get("cases", [])),
            "configs": {cfg: aggregate([r for r in rows if r["config"] == cfg]) for cfg in configs},
            "by_set": {cfg: {s: aggregate([r for r in rows if r["config"] == cfg and r["set"] == s])
                             for s in sorted({r["set"] for r in rows})} for cfg in configs},
            "by_trap": {cfg: by_trap([r for r in rows if r["config"] == cfg]) for cfg in configs},
            "budget": meta.get("budget")}


def write_summary(run_dir: Path, rows: list[dict], meta: dict) -> dict:
    summary = build_summary(rows, meta)
    (run_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (run_dir / "summary.md").write_text(summary_markdown(summary, rows), encoding="utf-8")
    return summary


def publish(run_dir: Path, summary: dict, path: Path = EVAL_RESULTS) -> Path:
    """Copy the run's summary to docs/EVAL_RESULTS.md with a provenance header (the only way that file changes)."""
    configs = ",".join(summary["configs"])
    header = (f"<!-- Generated by eval/run_eval.py --configs {configs} --set {summary['set']} on "
              f"{summary['started_at'][:10]} (profile {summary.get('profile') or 'unknown'}; run {Path(run_dir).name})."
              " Development and synthetic cases only; H01-H06 are never evaluated here. -->\n")
    Path(path).write_text(header + (Path(run_dir) / "summary.md").read_text(encoding="utf-8"), encoding="utf-8")
    return Path(path)


def read_rows(run_dir: Path) -> list[dict]:
    lines = (Path(run_dir) / "rows.jsonl").read_text(encoding="utf-8").splitlines()
    return [json.loads(line) for line in lines if line.strip()]


# ---------------------------------------------------------------- run

def gate_ranking(prepared) -> list[dict] | None:
    """The clarify gate's full ranking of a prepared run (`Prepared.ranked`; the asked `questions` when a workflow
    has no separate ranking), as C2 ClarifyQuestion dicts; None for a refused enquiry."""
    if prepared.refused:
        return None
    ranked = getattr(prepared, "ranked", None) or prepared.questions or []
    return [q.model_dump(mode="json") if hasattr(q, "model_dump") else dict(q) for q in ranked]


def evaluate(cases: list[Case], configs: list[str], gateway, kb, materials: Path, run_dir: Path,
             rubric: dict | None = None, log=print, skip: set[tuple[str, str]] = frozenset()) -> list[dict]:
    """Run every case under every configuration; one row per run appended to rows.jsonl, artefacts under runs/.
    `skip` holds (config, case id) pairs that an earlier, resumed part of the run already finished."""
    recorder = gateway if isinstance(gateway, RecordingGateway) else RecordingGateway(gateway)
    profile = getattr(getattr(gateway, "profile", None), "name", "fake")
    rows: list[dict] = []
    with (run_dir / "rows.jsonl").open("a", encoding="utf-8") as fh:
        for cfg in configs:
            pipeline = Pipeline(recorder, kb, Path(materials), CONFIGS[cfg]())
            for case in cases:
                enquiry = case.enquiry
                if (cfg, enquiry.case_id) in skip:
                    continue
                row = {"config": cfg, "set": case.set, "case_id": enquiry.case_id, "trap": case.trap,
                       "profile": profile}
                recorder.take()
                try:
                    prepared = pipeline.prepare(enquiry)          # Pipeline.run = prepare + write (C2)
                    result = pipeline.write(prepared)
                    calls = recorder.take()
                    ranked = gate_ranking(prepared)
                    cards = {**kb.cards, **{c.id: c for c in (result.pack.cards if result.pack else [])}}
                    judged = judged_sentences(calls, result.verification.verdicts, cards)
                    row |= case_metrics(result, case.expect, kb=kb, sources=[enquiry.text, enquiry.title],
                                        calls=calls, ranked=ranked)
                    row["run_id"] = result.manifest.run_id
                    save_case(run_dir / RUNS / cfg / enquiry.case_id, result, calls, judged, ranked)
                    if rubric is not None and result.report is not None:
                        judged_rubric = judge_report(enquiry.text, result.markdown, rubric, gateway)
                        row["judge_score"], row["judge"] = judged_rubric["total"], judged_rubric
                except Exception as e:  # noqa: BLE001 - one failing case must not stop the evaluation
                    recorder.take()
                    row["error"] = f"{type(e).__name__}: {e}"
                rows.append(row)
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
                log(f"{cfg:<12} {enquiry.case_id}: {row.get('error') or row.get('status') or row.get('scope')}")
    return rows


def main(argv: list[str] | None = None, gateway=None, kb=None, materials: Path = Path("materials")) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--configs", default=",".join(CONFIGS), help="comma-separated: " + ", ".join(CONFIGS))
    ap.add_argument("--set", dest="case_set", choices=["dev", "synthetic", "all"], default="all")
    ap.add_argument("--judge", action="store_true", help="score reports with the critic role and the rubric")
    ap.add_argument("--offset", type=int, default=0, help="skip the first N cases (to split a run over budget windows)")
    ap.add_argument("--limit", type=int, default=None, help="only N cases (for smoke runs)")
    ap.add_argument("--out", default=str(EVAL_DIR / "results"))
    ap.add_argument("--summarize", metavar="RUN_DIR", help="re-aggregate an existing run (no model call)")
    ap.add_argument("--resume", metavar="RUN_DIR",
                    help="continue an earlier run: only the (config, case) pairs it has not finished, same run dir")
    ap.add_argument("--publish", nargs="?", const=str(EVAL_RESULTS), default=None, metavar="PATH",
                    help=f"also write the summary to PATH (default {EVAL_RESULTS.relative_to(ROOT)})")
    args = ap.parse_args(argv)

    if args.summarize:
        run_dir = Path(args.summarize)
        meta_file = run_dir / "summary.json"
        meta = json.loads(meta_file.read_text(encoding="utf-8")) if meta_file.exists() else {}
        summary = write_summary(run_dir, read_rows(run_dir), meta)
        ablation_png(summary, run_dir / "ablation.png")
        if args.publish:
            print(f"Wrote {publish(run_dir, summary, Path(args.publish))}")
        print(f"Wrote {run_dir / 'summary.md'}")
        return 0

    configs = [c.strip() for c in args.configs.split(",") if c.strip()]
    unknown = [c for c in configs if c not in CONFIGS]
    if unknown:
        ap.error(f"unknown config(s): {', '.join(unknown)}")
    end = None if args.limit is None else args.offset + args.limit
    cases = select_cases(args.case_set, materials)[args.offset:end]

    if gateway is None:
        from prism.llm.gateway import build_gateway
        gateway = build_gateway()
    if kb is None:
        from prism.kb.loader import load_kb
        kb = load_kb(Path("kb"))
    previous: list[dict] = []
    if args.resume:
        previous = [r for r in read_rows(Path(args.resume)) if not r.get("error")]
    done = {(r["config"], r["case_id"]) for r in previous}
    todo = sum(1 for cfg in configs for c in cases if (cfg, c.enquiry.case_id) not in done)
    needed = sum(CALLS_BY_CONFIG[cfg] + (1 if args.judge else 0)
                 for cfg in configs for c in cases if (cfg, c.enquiry.case_id) not in done)
    budget = getattr(gateway, "budget", None)
    replay = bool(getattr(getattr(gateway, "cache", None), "replay", False))
    if not replay and budget is not None and not budget.can_afford(needed):
        print(f"Not enough LLM request budget for {todo} runs ({len(cases)} cases × {len(configs)} configs; about "
              f"{needed} requests needed). Remaining: {budget.snapshot()['remaining']}. Split the run with "
              "--offset/--limit, or continue it later with --resume.", file=sys.stderr)
        return 2

    rubric = load_rubric() if args.judge else None
    run_dir = Path(args.resume) if args.resume else new_run_dir(Path(args.out))
    if args.resume:                                     # failed runs are tried again; keep only the finished rows
        (run_dir / "rows.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in previous),
                                            encoding="utf-8")
    old_meta = json.loads((run_dir / "summary.json").read_text(encoding="utf-8")) \
        if args.resume and (run_dir / "summary.json").exists() else {}
    meta = {"started_at": old_meta.get("started_at") or datetime.now(UTC).isoformat(timespec="seconds"),
            "set": args.case_set, "profile": getattr(getattr(gateway, "profile", None), "name", "fake"),
            "configs": configs, "cases": [c.enquiry.case_id for c in cases]}
    rows = previous + evaluate(cases, configs, gateway, kb, Path(materials), run_dir, rubric, skip=done)
    meta["budget"] = budget.snapshot() if budget is not None else None
    summary = write_summary(run_dir, rows, meta)
    plotted = ablation_png(summary, run_dir / "ablation.png")
    if args.publish:
        print(f"Wrote {publish(run_dir, summary, Path(args.publish))}")
    print(f"Wrote {run_dir}" + ("" if plotted else " (matplotlib not installed: ablation.png skipped)"))
    return 0


__all__ = ["CALLS_BY_CONFIG", "CONFIGS", "GOLD_KEYS", "METRIC_KEYS", "RUN_KEYS", "TRAPS", "Case", "evaluate",
           "judge_report", "load_dev_gold", "load_rubric", "load_synthetic_cases", "main", "new_run_dir",
           "select_cases"]


if __name__ == "__main__":
    sys.exit(main())
