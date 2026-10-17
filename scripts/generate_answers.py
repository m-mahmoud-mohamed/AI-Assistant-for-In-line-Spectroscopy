"""Generate the official answers: one report per case plus index, compliance table and run manifest.

Usage: .venv/bin/python scripts/generate_answers.py --set eval|dev|all [--out outputs]
Every LLM call goes through the gateway cache in <out>/llm_cache, so `make verify-outputs` can replay it.
"""
from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path

from prism.cases import EVAL_TXT, EXAMPLES_DOCX, file_sha256, load_cases
from prism.kb.loader import load_kb
from prism.llm.gateway import build_gateway
from prism.orchestrator import PipelineFlags
from prism.outputs import generate

CALLS_PER_CASE = 6


def input_file_sha(materials: Path, case_set: str) -> str:
    """SHA-256 of the file the cases were read from ('all' hashes both file hashes in order)."""
    files = {"dev": [EXAMPLES_DOCX], "eval": [EVAL_TXT], "all": [EXAMPLES_DOCX, EVAL_TXT]}[case_set]
    shas = [file_sha256(materials / f) for f in files]
    return shas[0] if len(shas) == 1 else hashlib.sha256("".join(shas).encode()).hexdigest()


def main(argv: list[str] | None = None, gateway=None, kb=None, materials: Path = Path("materials")) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--set", dest="case_set", choices=["eval", "dev", "all"], default="eval")
    ap.add_argument("--out", default=None, help="output directory (default: outputs, or outputs/dev for --set dev)")
    args = ap.parse_args(argv)
    out = Path(args.out or ("outputs/dev" if args.case_set == "dev" else "outputs"))
    cases = load_cases(materials, args.case_set)
    gateway = gateway or build_gateway(cache_dir=out / "llm_cache")
    cache = getattr(gateway, "cache", None)
    replay = bool(getattr(cache, "replay", False))
    needed = CALLS_PER_CASE * len(cases)
    budget = getattr(gateway, "budget", None)
    if not replay and budget is not None and not budget.can_afford(needed):
        print(f"Not enough LLM request budget for {len(cases)} cases (about {needed} requests needed). "
              f"Remaining: {budget.snapshot()['remaining']}. Wait for the quota to reset or switch profile.",
              file=sys.stderr)
        return 2
    results = generate(cases, gateway, kb or load_kb(Path("kb")), out, materials,
                       input_file_sha(materials, args.case_set), args.case_set, PipelineFlags(deep=True), log=print)
    print(f"Wrote {len(results)} cases to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
