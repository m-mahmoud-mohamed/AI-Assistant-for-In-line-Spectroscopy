"""Export the sentences the support judge verified in an evaluation run, for the domain expert to label.

Usage: .venv/bin/python scripts/export_claims.py [RUN_DIR] [--configs full] [--max 300] [--out eval/claims/to_label.csv]
RUN_DIR defaults to the newest run under eval/results that stored per-case artefacts. Reads files only (no model call).

Each row: id, case, config, path, claim_type, sentence, cited quotes with pages, card ids, the judge's verdict and
reason, and empty `label` / `note` columns. The expert writes supported, partial or unsupported into `label`.
Re-exporting merges: rows already in the file keep their labels, new sentences are appended.
"""
from __future__ import annotations

import argparse
import sys
from collections import Counter
from pathlib import Path

if __package__ in (None, ""):                          # run as a script: make `eval` importable
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from eval.claims import TO_LABEL, collect, merge, read_csv, sample, write_csv
from eval.rundir import latest_run

RESULTS = Path(__file__).resolve().parents[1] / "eval" / "results"


def export(run_dir: Path, out: Path = TO_LABEL, configs: list[str] | None = None, limit: int | None = None) -> dict:
    """Write (or extend) the labelling sheet; returns counts for the summary line."""
    fresh = sample(collect(run_dir, configs), limit)
    existing = read_csv(out)
    rows = merge(fresh, existing)
    write_csv(rows, out)
    return {"run": Path(run_dir).name, "found": len(fresh), "new": len(rows) - len(existing), "total": len(rows),
            "labelled": sum(1 for r in rows if r.get("label")),
            "by_verdict": dict(Counter(r.get("judge_verdict") or "none" for r in rows))}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("run_dir", nargs="?", help="eval/results/<stamp> (default: the newest run with artefacts)")
    ap.add_argument("--configs", default="full", help="comma-separated configs to export (default: full)")
    ap.add_argument("--max", dest="limit", type=int, default=None,
                    help="at most N new sentences, spread over the judge's verdicts (150–300 is a good claim set)")
    ap.add_argument("--out", default=str(TO_LABEL))
    args = ap.parse_args(argv)
    run_dir = Path(args.run_dir) if args.run_dir else latest_run(RESULTS)
    if run_dir is None or not run_dir.is_dir():
        ap.error("no evaluation run with per-case artefacts found; run `make eval` first")
    configs = [c.strip() for c in args.configs.split(",") if c.strip()] or None
    stats = export(run_dir, Path(args.out), configs, args.limit)
    print(f"{args.out}: {stats['new']} new of {stats['found']} judged sentences from {stats['run']}; "
          f"{stats['total']} rows, {stats['labelled']} labelled; judge verdicts {stats['by_verdict']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
