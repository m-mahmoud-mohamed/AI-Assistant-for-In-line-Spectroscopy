"""Evaluate PRISM on development data and run the ablation (never the held-out evaluation set).

Usage: .venv/bin/python eval/run_eval.py [--configs full,rules_verify,rules_only,baseline]
                                         [--set dev|synthetic|all] [--judge] [--limit N] [--out eval/results]
Writes eval/results/<timestamp>/{rows.jsonl, summary.json, summary.md, ablation.png}. The PNG needs matplotlib
and is skipped when it is not installed.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

if __package__ in (None, ""):                          # run as a script: make `eval` and `prism` importable
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import yaml
from jinja2 import Environment, StrictUndefined
from pydantic import BaseModel, Field

from eval.metrics import METRIC_KEYS, aggregate, case_metrics
from prism.cases import load_dev_cases, sha256_text
from prism.orchestrator import Pipeline, PipelineFlags
from prism.schemas import Enquiry

EVAL_DIR = Path(__file__).resolve().parent
SYNTHETIC = EVAL_DIR / "synthetic_cases.yaml"
RUBRIC = EVAL_DIR / "rubric.yaml"
CALLS_PER_CASE = 5                                     # scope/extract/draft/critic/repair, roughly
CONFIGS = {
    "full": lambda: PipelineFlags(),
    "rules_verify": lambda: PipelineFlags(repair=False),
    "rules_only": lambda: PipelineFlags(verify=False),
    "baseline": lambda: PipelineFlags(rules=False, verify=False, repair=False, retrieval="bm25"),
}
ABLATION_ORDER = ("baseline", "rules_only", "rules_verify", "full")
PLOT_METRICS = (("trap_handled", "Trap handling (share)"), ("claim_support", "Claim support (share)"),
                ("invented_numbers", "Invented numbers (per case)"))
_jinja = Environment(undefined=StrictUndefined, trim_blocks=True, lstrip_blocks=True)


# ---------------------------------------------------------------- inputs

def load_synthetic_cases(path: Path = SYNTHETIC) -> list[dict]:
    return yaml.safe_load(Path(path).read_text(encoding="utf-8"))


def load_rubric(path: Path = RUBRIC) -> dict:
    return yaml.safe_load(Path(path).read_text(encoding="utf-8"))


def select_cases(case_set: str, materials: Path) -> list[tuple[str, Enquiry, dict | None]]:
    """(set name, enquiry, expectations) for the development and/or synthetic sets."""
    out: list[tuple[str, Enquiry, dict | None]] = []
    if case_set in ("dev", "all"):
        out += [("dev", e, None) for e in load_dev_cases(Path(materials))]
    if case_set in ("synthetic", "all"):
        for c in load_synthetic_cases():
            text = c["text"].strip()
            out.append(("synthetic", Enquiry(case_id=c["id"], title="", text=text, sha256=sha256_text(text),
                                             origin="case_file"), c["expect"]))
    return out


# ---------------------------------------------------------------- LLM judge

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


def summary_markdown(summary: dict, rows: list[dict]) -> str:
    configs = list(summary["configs"])
    keys = ["n", "errors", *[k for k in (*METRIC_KEYS, "judge_score") if any(k in r for r in rows)],
            "invented_numbers_total"]
    lines = ["# PRISM evaluation", "",
             f"Set: `{summary['set']}` · cases: {len(summary['cases'])} · started: {summary['started_at']}", "",
             ("Shares are means over the cases where a metric applies (— = not applicable). "
              "`invented_numbers` is the mean count per case."), "",
             "| Config | " + " | ".join(keys) + " |", "|---|" + "---|" * len(keys)]
    for cfg in configs:
        agg = summary["configs"][cfg]
        lines.append(f"| {cfg} | " + " | ".join(_fmt(agg.get(k)) for k in keys) + " |")
    synthetic = [r for r in rows if r["set"] == "synthetic"]
    if synthetic:
        ids = list(dict.fromkeys(r["case_id"] for r in synthetic))
        cell = {(r["config"], r["case_id"]): r for r in synthetic}
        lines += ["", "## Trap handling per synthetic case", "",
                  "| Case | " + " | ".join(configs) + " |", "|---|" + "---|" * len(configs)]
        for cid in ids:
            marks = []
            for cfg in configs:
                r = cell.get((cfg, cid), {})
                ok = r.get("trap_handled")
                marks.append("—" if ok is None else f"{'✅' if ok else '❌'} {r.get('status') or r.get('scope')}")
            lines.append(f"| {cid} | " + " | ".join(marks) + " |")
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
    colours = {"baseline": "#001070", "rules_only": "#0040C0", "rules_verify": "#0050E0", "full": "#00E5FF"}
    fig, axes = plt.subplots(1, len(PLOT_METRICS), figsize=(4 * len(PLOT_METRICS), 3.6))
    for ax, (key, title) in zip(axes, PLOT_METRICS):
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


def _run_dir(root: Path) -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    path, i = Path(root) / stamp, 1
    while path.exists():
        path, i = Path(root) / f"{stamp}-{i}", i + 1
    path.mkdir(parents=True)
    return path


# ---------------------------------------------------------------- main

def main(argv: list[str] | None = None, gateway=None, kb=None, materials: Path = Path("materials")) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--configs", default=",".join(CONFIGS), help="comma-separated: " + ", ".join(CONFIGS))
    ap.add_argument("--set", dest="case_set", choices=["dev", "synthetic", "all"], default="all")
    ap.add_argument("--judge", action="store_true", help="score reports with the critic role and the rubric")
    ap.add_argument("--limit", type=int, default=None, help="only the first N cases (for smoke runs)")
    ap.add_argument("--out", default=str(EVAL_DIR / "results"))
    args = ap.parse_args(argv)
    configs = [c.strip() for c in args.configs.split(",") if c.strip()]
    unknown = [c for c in configs if c not in CONFIGS]
    if unknown:
        ap.error(f"unknown config(s): {', '.join(unknown)}")
    cases = select_cases(args.case_set, materials)[:args.limit]

    if gateway is None:
        from prism.llm.gateway import build_gateway
        gateway = build_gateway()
    if kb is None:
        from prism.kb.loader import load_kb
        kb = load_kb(Path("kb"))
    needed = (CALLS_PER_CASE + (1 if args.judge else 0)) * len(cases) * len(configs)
    budget = getattr(gateway, "budget", None)
    replay = bool(getattr(getattr(gateway, "cache", None), "replay", False))
    if not replay and budget is not None and not budget.can_afford(needed):
        print(f"Not enough LLM request budget for {len(cases)} cases × {len(configs)} configs (about {needed} "
              f"requests needed). Remaining: {budget.snapshot()['remaining']}.", file=sys.stderr)
        return 2

    rubric = load_rubric() if args.judge else None
    run_dir = _run_dir(Path(args.out))
    started = datetime.now(UTC).isoformat(timespec="seconds")
    rows: list[dict] = []
    with (run_dir / "rows.jsonl").open("w", encoding="utf-8") as fh:
        for cfg in configs:
            pipeline = Pipeline(gateway, kb, Path(materials), CONFIGS[cfg]())
            for set_name, enquiry, expect in cases:
                row = {"config": cfg, "set": set_name, "case_id": enquiry.case_id}
                try:
                    result = pipeline.run(enquiry)
                    row |= case_metrics(result, expect, kb=kb, sources=[enquiry.text, enquiry.title])
                    row["run_id"] = result.manifest.run_id
                    if rubric is not None and result.report is not None:
                        judged = judge_report(enquiry.text, result.markdown, rubric, gateway)
                        row["judge_score"], row["judge"] = judged["total"], judged
                except Exception as e:  # noqa: BLE001 - one failing case must not stop the evaluation
                    row["error"] = f"{type(e).__name__}: {e}"
                rows.append(row)
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
                print(f"{cfg:<12} {enquiry.case_id}: {row.get('error') or row.get('status') or row.get('scope')}")

    summary = {"started_at": started, "set": args.case_set, "cases": [e.case_id for _, e, _ in cases],
               "configs": {cfg: aggregate([r for r in rows if r["config"] == cfg]) for cfg in configs},
               "by_set": {cfg: {s: aggregate([r for r in rows if r["config"] == cfg and r["set"] == s])
                                for s in sorted({r["set"] for r in rows})} for cfg in configs},
               "budget": budget.snapshot() if budget is not None else None}
    (run_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (run_dir / "summary.md").write_text(summary_markdown(summary, rows), encoding="utf-8")
    plotted = ablation_png(summary, run_dir / "ablation.png")
    print(f"Wrote {run_dir}" + ("" if plotted else " (matplotlib not installed: ablation.png skipped)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
