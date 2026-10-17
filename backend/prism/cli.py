"""Command line: prism assess --text "..." | --case D01 [--deep] [--out DIR]."""
from __future__ import annotations

import argparse
from pathlib import Path

from prism.cases import load_cases, sha256_text
from prism.kb.loader import load_kb
from prism.llm.gateway import build_gateway
from prism.orchestrator import Pipeline, PipelineFlags
from prism.schemas import Enquiry


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="prism")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("assess", help="assess one enquiry")
    src = a.add_mutually_exclusive_group(required=True)
    src.add_argument("--text", help="free-text enquiry")
    src.add_argument("--case", help="case ID from materials/, e.g. D01")
    a.add_argument("--deep", action="store_true", help="use the generator_deep role")
    a.add_argument("--out", default="outputs/adhoc", help="output directory")
    args = ap.parse_args(argv)
    materials = Path("materials")
    if args.case:
        enquiry = next((c for c in load_cases(materials, "all") if c.case_id == args.case), None)
        if enquiry is None:
            ap.error(f"unknown case {args.case!r}")
    else:
        if not args.text.strip():
            ap.error("--text must not be empty")
        enquiry = Enquiry(case_id="ADHOC", title="", text=args.text, sha256=sha256_text(args.text))
    result = Pipeline(build_gateway(), load_kb(), materials, PipelineFlags(deep=args.deep)).run(enquiry)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / f"{enquiry.case_id}.md").write_text(result.markdown, encoding="utf-8")
    (out / f"{enquiry.case_id}.manifest.json").write_text(result.manifest.model_dump_json(indent=2),
                                                          encoding="utf-8")
    if result.report:
        (out / f"{enquiry.case_id}.json").write_text(result.report.model_dump_json(indent=2), encoding="utf-8")
    print(out / f"{enquiry.case_id}.md")


if __name__ == "__main__":
    main()
