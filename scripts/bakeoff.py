"""Provider bake-off: the same evaluation on several LLM profiles, plus the latency benchmark, in docs/BAKEOFF.md.

Usage: .venv/bin/python scripts/bakeoff.py --profiles gwdg gemini [--set dev] [--configs full] [--offset N] [--limit N]
                                          [--bench-parallel 3 | --no-bench] [--reuse-cache]
                                          [--prices config/prices.yaml] [--out docs/BAKEOFF.md]
Per profile: eval/run_eval.py's cases on the chosen configs (about 7 LLM requests per case and config) and
scripts/bench_llm.py (one request per writer/judge/extractor model plus --bench-parallel). A profile whose API key
is not set, or whose request budget (config/llm.yaml limits) cannot cover the run, is skipped and named in the report.
Every call is live by default (a fresh LLM cache under .prism_cache/), so latencies and token counts are real.
Cost per report = tokens × config/prices.yaml, which the user fills in; empty prices show "—".
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

if __package__ in (None, ""):                          # run as a script: make `eval` importable
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from eval.costs import PRICES, cost, load_prices
from eval.run_eval import CONFIGS, evaluate, expected_calls, new_run_dir, select_cases, write_summary

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "BAKEOFF.md"
RESULTS = ROOT / "eval" / "results"
BENCH = ROOT / "scripts" / "bench_llm.py"
QUALITY = ("trap_handled", "status_agreement", "method_agreement", "premise_agreement", "cite_recall",
           "claim_support", "judge_supported_share", "citation_existence", "quote_fidelity", "invented_numbers",
           "fact_fidelity", "direct_answer_consistent", "question_value", "plan_ok", "questions_ok", "writer_fallback",
           "writer_truncation")
LATENCY = ("time_to_verdict_p50", "time_to_verdict_p90", "time_to_report_p50", "time_to_report_p90")
USAGE = ("llm_calls", "llm_live_calls", "tokens_in", "tokens_out", "writer_out_tokens")


def bench_models(profile: str) -> list[str]:
    """The models scripts/bench_llm.py times for a profile (writer, judge and extractor models)."""
    from prism.llm.profiles import load_profile
    p = load_profile(ROOT / "config" / "llm.yaml", profile)
    return list(dict.fromkeys(m for role in ("writer", "judge", "extractor") if role in p.roles
                              for m in p.roles[role].models))


def run_bench(profile: str, parallel: int) -> dict:
    """scripts/bench_llm.py in a subprocess (it reads the key from the environment and never prints it)."""
    cmd = [sys.executable, str(BENCH), "--profile", profile, "--parallel", str(parallel)]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=900, cwd=ROOT, env=dict(os.environ),
                              check=False)
    except (OSError, subprocess.SubprocessError) as exc:
        return {"error": f"{type(exc).__name__}: {exc}", "runs": []}
    runs = []
    for line in proc.stdout.splitlines():
        try:
            runs.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    out = {"runs": runs}
    if proc.returncode != 0:
        out["error"] = (proc.stderr.strip().splitlines() or [f"exit code {proc.returncode}"])[-1][:300]
    return out


def _gateway(profile: str, cache_dir: Path | None = None):
    from prism.llm.gateway import build_gateway
    return build_gateway(profile_name=profile, cache_dir=cache_dir)


def run_profile(profile: str, cases, configs: list[str], kb, materials: Path, results: Path, bench_parallel: int,
                gateway_factory: Callable = _gateway, bench: Callable | None = run_bench, case_set: str = "",
                log=print) -> dict:
    """Evaluation and benchmark for one profile; {"profile", "skipped"?, "run_dir", "summary", "bench"}."""
    out: dict = {"profile": profile}
    try:
        gateway = gateway_factory(profile)
    except Exception as exc:  # noqa: BLE001 - a broken profile is reported, the others still run
        return out | {"skipped": f"profile not usable: {type(exc).__name__}: {exc}"}
    prof = getattr(gateway, "profile", None)
    if prof is not None and hasattr(prof, "api_key") and not prof.api_key():
        return out | {"skipped": f"API key variable {prof.api_key_env} is not set"}
    bench_calls = 0
    if bench is not None and bench_parallel >= 0:
        try:
            bench_calls = len(bench_models(profile)) + bench_parallel
        except (KeyError, OSError, ValueError):
            bench_calls = bench_parallel
    needed = expected_calls(configs, len(cases)) + bench_calls
    budget = getattr(gateway, "budget", None)
    replay = bool(getattr(getattr(gateway, "cache", None), "replay", False))
    if not replay and budget is not None and not budget.can_afford(needed):
        return out | {"skipped": f"request budget too small for about {needed} requests "
                                 f"(remaining {budget.snapshot()['remaining']}); use --limit/--offset"}
    run_dir = new_run_dir(results)
    meta = {"started_at": datetime.now(UTC).isoformat(timespec="seconds"), "set": case_set, "profile": profile,
            "configs": configs, "cases": [c.enquiry.case_id for c in cases]}
    rows = evaluate(cases, configs, gateway, kb, materials, run_dir, log=lambda m: log(f"[{profile}] {m}"))
    meta["budget"] = budget.snapshot() if budget is not None else None
    out |= {"run_dir": str(run_dir), "summary": write_summary(run_dir, rows, meta)}
    if bench is not None and bench_parallel >= 0:
        out["bench"] = bench(profile, bench_parallel)
    return out


# ---------------------------------------------------------------- report

def _fmt(v) -> str:
    if v is None:
        return "—"
    return f"{v:.3f}".rstrip("0").rstrip(".") if isinstance(v, float) else str(v)


def _cell(agg: dict, key: str) -> str:
    ci = (agg.get("ci") or {}).get(key)
    return _fmt(agg.get(key)) + (f" [{_fmt(ci[0])}–{_fmt(ci[1])}]" if ci and agg.get(key) is not None else "")


def _money(v: float | None, currency: str) -> str:
    return "—" if v is None else f"{v:.4f} {currency}".strip()


def markdown(results: list[dict], args: dict, prices: dict) -> str:
    done = [r for r in results if "summary" in r]
    cfgs = args["configs"]
    header = (f"<!-- Generated by scripts/bakeoff.py --profiles {' '.join(args['profiles'])} --set {args['set']} "
              f"--configs {','.join(cfgs)} on {args['date']}. Development and synthetic cases only. -->")
    scope = (f"Set `{args['set']}` · {args['cases']} cases · configs: {', '.join(cfgs)} · profiles: "
             f"{', '.join(args['profiles'])}.")
    how = ("Means over cases with bootstrap 95 % confidence intervals in brackets (— = not applicable or not "
           "measured). Every profile ran the same cases with the same knowledge base and code.")
    lines = [header, "# Provider bake-off", "", scope, "", how, ""]
    for cfg in cfgs:
        cols = [r for r in done if cfg in r["summary"]["configs"]]
        if not cols:
            continue
        head = "| Metric | " + " | ".join(r["profile"] for r in cols) + " |"
        sep = "|---|" + "---|" * len(cols)
        aggs = [r["summary"]["configs"][cfg] for r in cols]
        lines += [f"## Quality (`{cfg}`)", "", head, sep]
        lines += ["| n / errors | " + " | ".join(f"{a['n']} / {a['errors']}" for a in aggs) + " |"]
        lines += [f"| {k} | " + " | ".join(_cell(a, k) for a in aggs) + " |" for k in QUALITY
                  if any(a.get(k) is not None for a in aggs)]
        lines += ["", f"## Latency (`{cfg}`, seconds)", "",
                  "Verdict = `engine_ready` (end of prepare); report = `run_completed`; from the run's first event.", "",
                  head, sep]
        lines += [f"| {k} | " + " | ".join(_fmt(a.get(k)) for a in aggs) + " |" for k in LATENCY]
        currency = prices.get("currency") or ""
        lines += ["", f"## Calls, tokens and cost per report (`{cfg}`)", "", head, sep]
        lines += [f"| {k} | " + " | ".join(_fmt(a.get(k)) for a in aggs) + " |" for k in USAGE]
        lines.append("| cost | " + " | ".join(_money(cost(a.get("tokens_by_model") or {}, prices), currency)
                                             for a in aggs) + " |")
        lines.append("")
    benches = [r for r in done if r.get("bench")]
    if benches:
        lines += ["## Provider latency benchmark (scripts/bench_llm.py)", "",
                  "| Profile | Model | first token s | total s | out tokens | decode tok/s |", "|---|---|---|---|---|---|"]
        for r in benches:
            for b in r["bench"].get("runs", []):
                if "model" in b:
                    lines.append(f"| {r['profile']} | {b['model']} | {_fmt(b.get('ttft_s'))} | {_fmt(b.get('total_s'))} "
                                 f"| {_fmt(b.get('out_tokens'))} | {_fmt(b.get('decode_tok_s'))} |")
                elif "parallel" in b:
                    lines.append(f"| {r['profile']} | {b['parallel']} parallel calls | — | {_fmt(b.get('wall_s'))} "
                                 f"| — | — |")
            if r["bench"].get("error"):
                lines.append(f"| {r['profile']} | benchmark failed: {r['bench']['error']} | — | — | — | — |")
        lines.append("")
    lines += ["## Notes", ""]
    for r in results:
        if r.get("skipped"):
            lines.append(f"- `{r['profile']}` skipped: {r['skipped']}.")
        elif r.get("run_dir"):
            lines.append(f"- `{r['profile']}`: run artefacts in `{Path(r['run_dir']).relative_to(ROOT).as_posix()}`"
                         if Path(r["run_dir"]).is_relative_to(ROOT) else f"- `{r['profile']}`: {r['run_dir']}")
    if not any(cost(r["summary"]["configs"][c].get("tokens_by_model") or {}, prices) is not None
               for r in done for c in r["summary"]["configs"]):
        lines.append(f"- Cost is \"—\" until prices are entered in `{PRICES.relative_to(ROOT).as_posix()}` "
                     "(per million tokens, per model).")
    lines += [("- Tokens and calls come from the recorded gateway calls; replayed (cached) responses count with "
               "their recorded usage. Embedding requests are not included."),
              ("- Writer truncation = a writer section cut off at max_tokens (failed as truncated, or answered at the "
               "cap).")]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None, gateway_factory: Callable | None = None, bench: Callable | None = run_bench,
         kb=None, materials: Path = Path("materials"), results: Path = RESULTS) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--profiles", nargs="+", required=True)
    ap.add_argument("--set", dest="case_set", choices=["dev", "synthetic", "all"], default="dev")
    ap.add_argument("--configs", default="full", help="comma-separated: " + ", ".join(CONFIGS))
    ap.add_argument("--offset", type=int, default=0)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--bench-parallel", type=int, default=3, help="parallel calls in the benchmark")
    ap.add_argument("--no-bench", action="store_true", help="skip scripts/bench_llm.py")
    ap.add_argument("--reuse-cache", action="store_true",
                    help="answer repeated requests from the shared LLM cache (default: a fresh cache, so every call "
                         "is live and the latencies are real)")
    ap.add_argument("--prices", default=str(PRICES))
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args(argv)
    configs = [c.strip() for c in args.configs.split(",") if c.strip()]
    if unknown := [c for c in configs if c not in CONFIGS]:
        ap.error(f"unknown config(s): {', '.join(unknown)}")
    end = None if args.limit is None else args.offset + args.limit
    cases = select_cases(args.case_set, materials)[args.offset:end]
    if kb is None:
        from prism.kb.loader import load_kb
        kb = load_kb(ROOT / "kb")
    results.mkdir(parents=True, exist_ok=True)
    if gateway_factory is None:
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        cache_dir = None if args.reuse_cache else ROOT / ".prism_cache" / f"bakeoff-{stamp}"

        def gateway_factory(profile: str):
            return _gateway(profile, cache_dir)
    out = [run_profile(p, cases, configs, kb, materials, results, -1 if args.no_bench else args.bench_parallel,
                       gateway_factory, None if args.no_bench else bench, args.case_set) for p in args.profiles]
    meta = {"profiles": args.profiles, "set": args.case_set, "configs": configs, "cases": len(cases),
            "date": datetime.now(UTC).date().isoformat()}
    Path(args.out).write_text(markdown(out, meta, load_prices(Path(args.prices))), encoding="utf-8")
    for r in out:
        print(f"{r['profile']}: " + (f"skipped ({r['skipped']})" if r.get("skipped") else r["run_dir"]))
    print(f"Wrote {args.out}")
    return 0 if any("summary" in r for r in out) else 1


if __name__ == "__main__":
    sys.exit(main())
