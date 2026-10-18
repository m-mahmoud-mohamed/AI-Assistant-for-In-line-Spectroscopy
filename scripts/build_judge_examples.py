"""Turn expert-labelled sentences into the support judge's few-shot examples (kb/judge_examples.yaml).

Usage: .venv/bin/python scripts/build_judge_examples.py [eval/claims/to_label.csv] [--per-label 4]
                                                       [--out kb/judge_examples.yaml]
Reads the CSV and the knowledge base only (no model call). Picks the same number of short examples per label
(supported, partial, unsupported): first the sentences where the judge disagreed with the expert, then those with an
expert note, then the shortest. Quotes are written the way the judge sees them ("[card id | scope] quote").
prism/stages/verify.py loads at most 12 examples, so 4 per label fills the prompt.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

if __package__ in (None, ""):                          # run as a script: make `eval` importable
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import yaml

from eval.claims import LABELS, TO_LABEL, labelled, read_csv

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "kb" / "judge_examples.yaml"
MAX_CLAIM, MAX_QUOTE, MAX_QUOTES = 240, 300, 2
DEFAULT_REASON = {"supported": "the quotes state it at this strength",
                  "partial": "stronger or wider than the quotes",
                  "unsupported": "the quotes do not state it"}
HEADER = """\
# Few-shot examples for the support judge (prism/stages/verify.py loads up to 12; prompt: llm/prompts/judge.j2).
# Built by `make judge-examples` (scripts/build_judge_examples.py) from the expert-labelled claim set in
# eval/claims/to_label.csv. Edit by hand only to correct a label; keep the labels balanced and the entries short.
#
# Schema (a list; empty = the judge runs without examples):
# - claim: "the sentence as it appeared in a report"
#   quotes: ["[S01-p17-nir-reflection-opaque | process_application] Inline NIR Reflection is ..."]  # as the judge saw them
#   verdict: supported | partial | unsupported      # the domain expert's label
#   reason: "at most 10 words"                      # the expert's note, or a default per label
#   source_id: C-0123456789                          # row id in eval/claims/to_label.csv
"""


def _short(text: str, n: int) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= n else text[:n - 1].rstrip() + "…"


def judge_quotes(row: dict, cards: dict) -> list[str]:
    """The cited quotes as the judge prompt shows them; the readable CSV column when a card is unknown."""
    out = []
    for cid in [c.strip() for c in row.get("card_ids", "").split(",") if c.strip()]:
        card = cards.get(cid)
        if card is not None:
            out.append(f"[{cid} | {card.scope.value}] {_short(card.quote, MAX_QUOTE)}")
    if not out and row.get("quotes"):
        out = [_short(q, MAX_QUOTE) for q in row["quotes"].split(" || ") if q.strip()]
    return out[:MAX_QUOTES]


def _reason(row: dict) -> str:
    words = " ".join(row.get("note", "").split()).split(" ")
    return " ".join(words[:10]) if row.get("note", "").strip() else DEFAULT_REASON[row["label"]]


def pick(rows: list[dict], per_label: int = 4, balanced: bool = True) -> list[dict]:
    """Labelled rows chosen per label: disagreements first, then rows with a note, then the shortest sentences."""
    groups = {label: [] for label in LABELS}
    for r in labelled(rows):
        if len(r["sentence"]) <= MAX_CLAIM:
            groups[r["label"]].append(r)
    for label, g in groups.items():
        g.sort(key=lambda r: (r.get("judge_verdict") == label, not r.get("note"), len(r["sentence"]), r["id"]))
    present = [len(g) for g in groups.values() if g]
    k = min([per_label, *present]) if balanced and present else per_label
    return [r for label in LABELS for r in groups[label][:k]]


def build(rows: list[dict], cards: dict, per_label: int = 4, balanced: bool = True) -> list[dict]:
    return [{"claim": r["sentence"], "quotes": judge_quotes(r, cards), "verdict": r["label"], "reason": _reason(r),
             "source_id": r["id"]} for r in pick(rows, per_label, balanced)]


def write(examples: list[dict], path: Path = OUT) -> None:
    body = yaml.safe_dump(examples, allow_unicode=True, sort_keys=False, width=110) if examples else "[]\n"
    Path(path).write_text(HEADER + body, encoding="utf-8")


def main(argv: list[str] | None = None, kb=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("csv", nargs="?", default=str(TO_LABEL))
    ap.add_argument("--per-label", type=int, default=4)
    ap.add_argument("--unbalanced", action="store_true", help="take up to --per-label from each label regardless")
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args(argv)
    if not Path(args.csv).exists():
        ap.error(f"{args.csv} not found; run `make claims` and label it first")
    if kb is None:
        from prism.kb.loader import load_kb
        kb = load_kb(ROOT / "kb")
    rows = read_csv(Path(args.csv))
    examples = build(rows, kb.cards, args.per_label, not args.unbalanced)
    write(examples, Path(args.out))
    counts = {label: sum(1 for e in examples if e["verdict"] == label) for label in LABELS}
    missing = [label for label, n in counts.items() if not n]
    print(f"Wrote {len(examples)} examples to {args.out} {counts}"
          + (f"; no labelled example for {', '.join(missing)}" if missing else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
