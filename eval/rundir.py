"""What an evaluation run stores per case, and how to read it back.

    eval/results/<stamp>/
        rows.jsonl, summary.json, summary.md
        runs/<config>/<case_id>/
            events.jsonl        the run's event log (engine_ready carries the clarify gate's questions)
            manifest.json       models, prompt hashes, stage timings
            report.json         the final report (absent when the scope guard refused)
            verification.json   issues and the support judge's verdicts
            calls.json          the recorded LLM calls (role, model, usage, latency; no prompt text)
            judge.json          the sentences the support judge saw, with cited quotes and verdicts
            questions.json      the clarify gate's full ranking (C2 ClarifyQuestion dicts), best first

The claim-set export (scripts/export_claims.py) and the offline metric recomputation read these files only, so they
never call a model.
"""
from __future__ import annotations

import json
from pathlib import Path

from prism.schemas import ClaimVerdict, Issue

RUNS = "runs"


def _dump(path: Path, data) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def save_case(case_dir: Path, result, calls: list[dict], judged: list[dict], ranked: list[dict] | None = None) -> None:
    case_dir = Path(case_dir)
    case_dir.mkdir(parents=True, exist_ok=True)
    with (case_dir / "events.jsonl").open("w", encoding="utf-8") as fh:
        for e in result.events:
            fh.write(json.dumps(e, ensure_ascii=False, default=str) + "\n")
    _dump(case_dir / "manifest.json", result.manifest.model_dump(mode="json"))
    if result.report is not None:
        _dump(case_dir / "report.json", result.report.model_dump(mode="json"))
    _dump(case_dir / "verification.json", result.verification.model_dump(mode="json"))
    calls_out = [{k: v for k, v in c.items() if k not in ("claims", "verdicts")} for c in calls]
    _dump(case_dir / "calls.json", calls_out)
    _dump(case_dir / "judge.json", judged)
    if ranked is not None:
        _dump(case_dir / "questions.json", ranked)


def _read_json(path: Path, default):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


def load_case(case_dir: Path) -> dict:
    """The stored artefacts of one case: events, manifest, report (dict or None), calls (None when not recorded),
    issues and verdicts (model objects), judged sentences."""
    case_dir = Path(case_dir)
    events_file = case_dir / "events.jsonl"
    events = [json.loads(line) for line in events_file.read_text(encoding="utf-8").splitlines() if line.strip()] \
        if events_file.exists() else []
    verification = _read_json(case_dir / "verification.json", {})
    calls_file = case_dir / "calls.json"
    return {"events": events, "manifest": _read_json(case_dir / "manifest.json", {}),
            "report": _read_json(case_dir / "report.json", None),
            "calls": _read_json(calls_file, []) if calls_file.exists() else None,
            "issues": [Issue.model_validate(i) for i in verification.get("issues", [])],
            "verdicts": [ClaimVerdict.model_validate(v) for v in verification.get("verdicts", [])],
            "judge": _read_json(case_dir / "judge.json", []),
            "ranked": _read_json(case_dir / "questions.json", None)}


def case_dirs(run_dir: Path, configs: list[str] | None = None) -> list[tuple[str, str, Path]]:
    """(config, case id, directory) for every stored case of an evaluation run, in a stable order."""
    root = Path(run_dir) / RUNS
    if not root.is_dir():
        return []
    out = []
    for cfg_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        if configs and cfg_dir.name not in configs:
            continue
        out += [(cfg_dir.name, d.name, d) for d in sorted(p for p in cfg_dir.iterdir() if p.is_dir())]
    return out


def latest_run(results: Path) -> Path | None:
    """The newest evaluation run directory that stored per-case artefacts."""
    runs = sorted(p for p in Path(results).iterdir() if p.is_dir() and (p / RUNS).is_dir()) \
        if Path(results).is_dir() else []
    return runs[-1] if runs else None


def stored_run_metrics(case_dir: Path) -> dict:
    """Run-behaviour metrics recomputed from a stored case (no model call)."""
    from eval.metrics import run_metrics
    case = load_case(case_dir)
    return run_metrics(case["events"], case["calls"], case["issues"], case["verdicts"],
                       case["manifest"].get("timings"), case["manifest"], case["ranked"])
