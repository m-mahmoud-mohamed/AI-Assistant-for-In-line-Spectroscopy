"""Write docs/KB_COVERAGE.md: per source page, its cards, the rules citing it and the output cases citing it.

Usage: .venv/bin/python scripts/kb_coverage.py [--kb kb] [--outputs outputs] [--doc docs/KB_COVERAGE.md]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from prism.kb.loader import load_kb
from prism.outputs import kb_coverage


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--kb", default="kb")
    ap.add_argument("--outputs", default="outputs")
    ap.add_argument("--doc", default="docs/KB_COVERAGE.md")
    args = ap.parse_args(argv)
    doc = Path(args.doc)
    doc.parent.mkdir(parents=True, exist_ok=True)
    doc.write_text(kb_coverage(load_kb(Path(args.kb)), Path(args.outputs)), encoding="utf-8")
    print(doc)
    return 0


if __name__ == "__main__":
    sys.exit(main())
