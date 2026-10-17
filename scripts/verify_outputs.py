"""Prove the committed answers were not edited by hand: replay every recorded case from the LLM cache.

Usage: PRISM_REPLAY=1 .venv/bin/python scripts/verify_outputs.py [--out outputs]
Exits 0 when the regenerated JSON (minus volatile keys) and Markdown match the committed files, 1 otherwise.
"""
from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

from prism.kb.loader import load_kb
from prism.llm.cache import ReplayMiss
from prism.llm.gateway import build_gateway
from prism.outputs import MANIFEST, replay_and_compare


def main(argv: list[str] | None = None, gateway=None, kb=None, materials: Path = Path("materials")) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default="outputs", help="directory with the committed outputs")
    args = ap.parse_args(argv)
    out = Path(args.out)
    if not (out / MANIFEST).exists():
        print(f"{out / MANIFEST} not found; run `make answers` first.")
        return 1
    gateway = gateway or build_gateway(cache_dir=out / "llm_cache", replay=True)
    with tempfile.TemporaryDirectory(prefix="prism-verify-") as tmp:
        try:
            diffs = replay_and_compare(out, gateway, kb or load_kb(Path("kb")), materials, Path(tmp))
        except ReplayMiss as exc:
            print(f"Replay failed: {exc}. The cache does not match the committed outputs.")
            return 1
    if diffs:
        for d in diffs:
            print(d, end="" if d.endswith("\n") else "\n")
        print(f"FAIL: {len(diffs)} file(s) differ from the replayed run.")
        return 1
    print(f"OK: {out} matches the replayed run.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
