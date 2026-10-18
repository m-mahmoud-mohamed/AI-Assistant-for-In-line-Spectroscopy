"""Agreement between the support judge and the domain expert on the labelled claim set.

Usage: .venv/bin/python scripts/judge_agreement.py [eval/claims/to_label.csv] [--out eval/claims/agreement.md]
Reads the CSV only (no model call). Reports accuracy, balanced accuracy, Cohen's kappa (unweighted and linear-
weighted over supported > partial > unsupported) and the confusion matrix, each with a bootstrap 95 % CI, the same
for the binary view (supported vs not), and a prediction-powered estimate of the expert-supported rate over every
exported sentence (labelled or not).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if __package__ in (None, ""):                          # run as a script: make `eval` importable
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from eval.claims import LABELS, TO_LABEL, labelled, read_csv
from eval.stats import accuracy, balanced_accuracy, bootstrap, cohen_kappa, confusion, ppi_mean

BINARY = ("supported", "not supported")


def _binary(label: str) -> str:
    return "supported" if label == "supported" else "not supported"


def _ci(pairs, fn):
    ci = bootstrap(pairs, lambda s: fn([t for t, _ in s], [p for _, p in s]))
    return [round(ci[0], 3), round(ci[1], 3)] if ci else None


def _block(pairs: list[tuple[str, str]], labels) -> dict:
    truth, pred = [t for t, _ in pairs], [p for _, p in pairs]
    out = {"n": len(pairs), "confusion": confusion(truth, pred, labels), "labels": list(labels)}
    for name, fn in (("accuracy", accuracy), ("balanced_accuracy", lambda t, p: balanced_accuracy(t, p, labels)),
                     ("kappa", lambda t, p: cohen_kappa(t, p, labels)),
                     ("kappa_linear", lambda t, p: cohen_kappa(t, p, labels, "linear"))):
        value = fn(truth, pred)
        out[name] = round(value, 3) if value is not None else None
        out[f"{name}_ci"] = _ci(pairs, fn)
    per = {}
    for i, label in enumerate(labels):
        col = sum(row[i] for row in out["confusion"])
        row_total = sum(out["confusion"][i])
        per[label] = {"precision": round(out["confusion"][i][i] / col, 3) if col else None,
                      "recall": round(out["confusion"][i][i] / row_total, 3) if row_total else None,
                      "expert": row_total, "judge": col}
    out["per_label"] = per
    return out


def agreement(rows: list[dict]) -> dict:
    """Judge vs expert on the labelled rows; PPI support rate over all rows that have a judge verdict."""
    done = [r for r in labelled(rows) if r.get("judge_verdict") in LABELS]
    pairs = [(r["label"], r["judge_verdict"]) for r in done]
    out = {"labelled": len(done), "rows": len(rows)}
    if not pairs:
        return out
    out["three_level"] = _block(pairs, LABELS)
    out["binary"] = _block([(_binary(t), _binary(p)) for t, p in pairs], BINARY)
    done_ids = {r["id"] for r in done}
    unlabelled = [1.0 if r.get("judge_verdict") == "supported" else 0.0 for r in rows
                  if r["id"] not in done_ids and r.get("judge_verdict") in LABELS]
    lab_pred = [1.0 if p == "supported" else 0.0 for _, p in pairs]
    lab_true = [1.0 if t == "supported" else 0.0 for t, _ in pairs]
    out["support_rate"] = {"judge": round(sum(lab_pred) / len(lab_pred), 3),
                           "expert": round(sum(lab_true) / len(lab_true), 3), "unlabelled": len(unlabelled)}
    ppi = ppi_mean(unlabelled, lab_pred, lab_true)
    if ppi:
        out["support_rate"]["ppi"] = [round(x, 3) for x in ppi]
    return out


def _fmt(v) -> str:
    return "—" if v is None else (f"{v:.3f}".rstrip("0").rstrip(".") if isinstance(v, float) else str(v))


def _ci_txt(block: dict, key: str) -> str:
    ci = block.get(f"{key}_ci")
    return _fmt(block.get(key)) + (f" [{_fmt(ci[0])}–{_fmt(ci[1])}]" if ci else "")


def markdown(result: dict, source: str) -> str:
    lines = ["# Support judge vs domain expert", "",
             f"Claim set: `{source}` · {result['labelled']} labelled of {result['rows']} exported sentences.", ""]
    if not result.get("three_level"):
        return "\n".join(lines + ["No labelled rows yet: fill the `label` column (supported, partial, unsupported).",
                                  ""])
    for title, key in (("Three levels (supported, partial, unsupported)", "three_level"),
                       ("Binary (supported vs not)", "binary")):
        b = result[key]
        lines += [f"## {title}", "", "Bootstrap 95 % confidence intervals over sentences in brackets.", "",
                  "| Metric | Value |", "|---|---|"]
        lines += [f"| {m} | {_ci_txt(b, m)} |" for m in ("accuracy", "balanced_accuracy", "kappa", "kappa_linear")]
        lines += ["", "Confusion matrix (rows = expert, columns = judge):", "",
                  "| expert \\ judge | " + " | ".join(b["labels"]) + " | precision / recall |",
                  "|---|" + "---|" * (len(b["labels"]) + 1)]
        for label, row in zip(b["labels"], b["confusion"], strict=True):
            p = b["per_label"][label]
            lines.append(f"| {label} | " + " | ".join(str(x) for x in row)
                         + f" | {_fmt(p['precision'])} / {_fmt(p['recall'])} |")
        lines.append("")
    s = result["support_rate"]
    lines += ["## Support rate", "",
              f"- Judge on the labelled sentences: {_fmt(s['judge'])}; expert: {_fmt(s['expert'])}.",
              (f"- Prediction-powered estimate of the expert-supported rate over all {s['unlabelled'] + result['labelled']}"
               f" exported sentences: {_fmt(s['ppi'][0])} [{_fmt(s['ppi'][1])}–{_fmt(s['ppi'][2])}]."
               if s.get("ppi") else ""), ""]
    return "\n".join(line for line in lines if line is not None) + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("csv", nargs="?", default=str(TO_LABEL))
    ap.add_argument("--out", help="also write the report to this Markdown file")
    ap.add_argument("--json", action="store_true", help="print the numbers as JSON instead of Markdown")
    args = ap.parse_args(argv)
    if not Path(args.csv).exists():
        ap.error(f"{args.csv} not found; run `make claims` and label it first")
    result = agreement(read_csv(Path(args.csv)))
    text = json.dumps(result, indent=2) if args.json else markdown(result, args.csv)
    if args.out:
        Path(args.out).write_text(markdown(result, args.csv), encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
