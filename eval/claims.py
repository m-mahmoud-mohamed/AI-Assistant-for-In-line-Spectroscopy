"""The expert claim set: sentences the support judge saw, exported for labelling, read back after labelling.

eval/claims/to_label.csv has one row per distinct sentence (id = hash of case, sentence and cited cards, so a
re-export keeps the labels already entered). The domain expert fills `label` with supported, partial or unsupported
(the judge's 3-level rubric, llm/prompts/judge.j2) and may explain it in `note`.
"""
from __future__ import annotations

import csv
import hashlib
import random
from collections.abc import Iterable
from pathlib import Path

from eval.rundir import case_dirs, load_case

CLAIMS_DIR = Path(__file__).resolve().parent / "claims"
TO_LABEL = CLAIMS_DIR / "to_label.csv"
LABELS = ("supported", "partial", "unsupported")
COLUMNS = ("id", "case", "config", "path", "claim_type", "sentence", "quotes", "card_ids", "judge_verdict",
           "judge_reason", "label", "note", "run")
EXPERT = ("label", "note")
SEED = 11


def claim_id(case: str, sentence: str, card_ids: Iterable[str]) -> str:
    key = f"{case}|{' '.join(sentence.split())}|{','.join(sorted(card_ids))}"
    return "C-" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:10]


def quotes_text(quotes: list[dict]) -> str:
    """Cited quotes with their pages, readable in a spreadsheet cell."""
    return " || ".join(f"{q['citation']} [{q.get('scope', '')}] {q['id']}: “{q['quote']}”" for q in quotes)


def collect(run_dir: Path, configs: list[str] | None = None) -> list[dict]:
    """One row per distinct judged sentence of an evaluation run (first occurrence wins)."""
    rows: dict[str, dict] = {}
    for config, case, path in case_dirs(run_dir, configs):
        for s in load_case(path)["judge"]:
            cid = claim_id(case, s["text"], s.get("ids", []))
            rows.setdefault(cid, {"id": cid, "case": case, "config": config, "path": s.get("path", ""),
                                  "claim_type": s.get("claim_type", ""), "sentence": s["text"],
                                  "quotes": quotes_text(s.get("quotes", [])), "card_ids": ",".join(s.get("ids", [])),
                                  "judge_verdict": s.get("verdict") or "", "judge_reason": s.get("reason", ""),
                                  "label": "", "note": "", "run": Path(run_dir).name})
    return list(rows.values())


def sample(rows: list[dict], limit: int | None, seed: int = SEED) -> list[dict]:
    """At most `limit` rows, spread over the judge's verdicts (round robin over shuffled groups), so partial and
    unsupported sentences are not drowned by the supported ones."""
    if limit is None or len(rows) <= limit:
        return list(rows)
    rng = random.Random(seed)
    groups = {}
    for r in rows:
        groups.setdefault(r.get("judge_verdict") or "", []).append(r)
    for g in groups.values():
        rng.shuffle(g)
    order = sorted(groups, key=lambda v: (LABELS.index(v) if v in LABELS else len(LABELS), v))
    out: list[dict] = []
    while len(out) < limit:
        for v in order:
            if groups[v] and len(out) < limit:
                out.append(groups[v].pop())
    return sorted(out, key=lambda r: (r["case"], r["path"], r["id"]))


def merge(fresh: list[dict], existing: list[dict]) -> list[dict]:
    """Existing rows keep their place and their expert columns; new sentences are appended."""
    have = {r["id"]: r for r in existing}
    out = [dict(r) for r in existing]
    out += [r for r in fresh if r["id"] not in have]
    return out


def read_csv(path: Path = TO_LABEL) -> list[dict]:
    path = Path(path)
    if not path.exists():
        return []
    with path.open(encoding="utf-8", newline="") as fh:
        return [{c: (row.get(c) or "").strip() for c in COLUMNS} for row in csv.DictReader(fh)]


def write_csv(rows: list[dict], path: Path = TO_LABEL) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(COLUMNS), extrasaction="ignore")
        writer.writeheader()
        for r in rows:
            writer.writerow({c: r.get(c, "") for c in COLUMNS})


def labelled(rows: list[dict]) -> list[dict]:
    """Rows the expert labelled with one of the three verdicts (case and spacing of the label are forgiven)."""
    out = []
    for r in rows:
        label = r.get("label", "").strip().lower()
        if label in LABELS:
            out.append({**r, "label": label})
    return out
