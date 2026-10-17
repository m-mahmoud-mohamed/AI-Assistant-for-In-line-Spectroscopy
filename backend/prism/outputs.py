"""Shared helpers for the official outputs: per-case files, index, compliance, manifest, replay diff, KB coverage."""
from __future__ import annotations

import difflib
import json
import subprocess
from collections import defaultdict
from collections.abc import Iterable, Sequence
from pathlib import Path

from prism.cases import load_cases
from prism.kb.loader import KnowledgeBase
from prism.orchestrator import Pipeline, PipelineFlags, RunResult
from prism.schemas import Enquiry, RecRole
from prism.stages.checks import POLICY_IDS

VOLATILE_KEYS = ("created_at", "started_at", "finished_at", "timings", "git_commit")
MANIFEST = "run_manifest.json"
_SKIP_JSON = {MANIFEST}


def git_commit() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], check=False, capture_output=True,
                              text=True, timeout=5).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def _dump(data) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2, sort_keys=False) + "\n"


def _cell(text: object) -> str:
    return str(text).replace("|", "\\|").replace("\n", " ").strip()


def _case_id(result: RunResult) -> str:
    return result.report.case_id if result.report else result.manifest.case_id


def case_json(result: RunResult) -> dict:
    """The report as JSON, or a refusal record when the scope guard refused the enquiry."""
    if result.report is not None:
        return result.report.model_dump(mode="json")
    return {"case_id": result.manifest.case_id, "run_id": result.manifest.run_id, "refused": True,
            "scope": result.scope.model_dump(mode="json")}


# ---------------------------------------------------------------- writers

def write_case(result: RunResult, out_dir: Path) -> None:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    cid = _case_id(result)
    (out_dir / f"{cid}.json").write_text(_dump(case_json(result)), encoding="utf-8")
    (out_dir / f"{cid}.md").write_text(result.markdown, encoding="utf-8")


def _failed_checks(result: RunResult) -> int:
    return sum(1 for ok in result.report.compliance.values() if not ok) if result.report else 0


def write_index(results: Sequence[RunResult], out_dir: Path) -> None:
    lines = ["# PRISM answers", "",
             "| Case | Title | Status | Direct answer | Primary method(s) | Failed checks |",
             "|---|---|---|---|---|---|"]
    for r in results:
        if r.report is None:
            lines.append(f"| {_case_id(r)} |  | REFUSED ({r.scope.label.value}) | — | — | 0 |")
            continue
        rep = r.report
        primary = "; ".join(" + ".join(rec.methods) for rec in rep.recommendations if rec.role == RecRole.PRIMARY)
        lines.append(f"| {rep.case_id} | {_cell(rep.title)} | {rep.decision_status.value} | "
                     f"{rep.direct_answer.verdict.value} | {_cell(primary) or '—'} | {_failed_checks(r)} |")
    Path(out_dir, "index.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_compliance(results: Sequence[RunResult], out_dir: Path) -> None:
    lines = ["# Compliance", "", "✅ = check passed, ❌ = check failed, — = refused by the scope guard.", "",
             "| Case | " + " | ".join(POLICY_IDS) + " |", "|---|" + "---|" * len(POLICY_IDS)]
    for r in results:
        if r.report is None:
            cells = ["—"] * len(POLICY_IDS)
        else:
            cells = ["✅" if r.report.compliance.get(pid, False) else "❌" for pid in POLICY_IDS]
        lines.append(f"| {_case_id(r)} | " + " | ".join(cells) + " |")
    Path(out_dir, "compliance.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_manifest(results: Sequence[RunResult], out_dir: Path, input_file_sha: str, case_set: str = "eval") -> None:
    manifests = [r.manifest.model_dump(mode="json") for r in results]
    profiles = sorted({m["profile"] for m in manifests})
    data = {"set": case_set, "evaluation_file_sha256": input_file_sha, "git_commit": git_commit(),
            "profile": profiles[0] if len(profiles) == 1 else ",".join(profiles),
            "cases": [m["case_id"] for m in manifests], "manifests": manifests}
    Path(out_dir, MANIFEST).write_text(_dump(data), encoding="utf-8")


def comparable(report_json: dict) -> dict:
    """A copy of the JSON without volatile keys (at any depth), for replay comparison."""
    def strip(obj):
        if isinstance(obj, dict):
            return {k: strip(v) for k, v in obj.items() if k not in VOLATILE_KEYS}
        if isinstance(obj, list):
            return [strip(v) for v in obj]
        return obj
    return strip(report_json)


# ---------------------------------------------------------------- generation and replay

def generate(cases: Iterable[Enquiry], gateway, kb: KnowledgeBase, out_dir: Path, materials: Path = Path("materials"),
             input_file_sha: str = "", case_set: str = "eval", flags: PipelineFlags | None = None,
             log=None) -> list[RunResult]:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    pipeline = Pipeline(gateway, kb, Path(materials), flags or PipelineFlags(deep=True))
    results = []
    for case in cases:
        result = pipeline.run(case)
        write_case(result, out_dir)
        results.append(result)
        if log:
            status = result.report.decision_status.value if result.report else "REFUSED"
            log(f"{case.case_id}: {status}")
    write_index(results, out_dir)
    write_compliance(results, out_dir)
    write_manifest(results, out_dir, input_file_sha, case_set)
    return results


def _text_diff(committed: str, fresh: str, name: str) -> str:
    return "".join(difflib.unified_diff(committed.splitlines(keepends=True), fresh.splitlines(keepends=True),
                                        fromfile=f"committed/{name}", tofile=f"replayed/{name}"))


def _read(path: Path) -> str | None:
    return path.read_text(encoding="utf-8") if path.exists() else None


def compare_dirs(committed: Path, fresh: Path, case_ids: Sequence[str]) -> list[str]:
    """Unified diffs between committed and regenerated outputs (empty list = identical)."""
    diffs = []
    names = [f"{cid}.{ext}" for cid in case_ids for ext in ("json", "md")]
    for name in [*names, "index.md", "compliance.md", MANIFEST]:
        old, new = _read(Path(committed) / name), _read(Path(fresh) / name)
        if old is None or new is None:
            diffs.append(f"{name}: missing in {'committed' if old is None else 'replayed'} outputs\n")
            continue
        if name.endswith(".json"):
            old = _dump(comparable(json.loads(old)))
            new = _dump(comparable(json.loads(new)))
        if old != new:
            diffs.append(_text_diff(old, new, name))
    return diffs


def replay_and_compare(out_dir: Path, gateway, kb: KnowledgeBase, materials: Path, tmp_dir: Path) -> list[str]:
    """Regenerate every case of the committed run manifest into tmp_dir and diff against out_dir."""
    manifest = json.loads((Path(out_dir) / MANIFEST).read_text(encoding="utf-8"))
    recorded = {m["case_id"]: m for m in manifest["manifests"]}
    by_id = {c.case_id: c for c in load_cases(Path(materials), manifest["set"])}
    problems = []
    cases = []
    for cid in manifest["cases"]:
        case = by_id.get(cid)
        if case is None:
            problems.append(f"{cid}: not found in the {manifest['set']} case set\n")
        elif case.sha256 != recorded[cid]["input_sha256"]:
            problems.append(f"{cid}: input text changed since the recorded run\n")
        else:
            cases.append(case)
    if problems:
        return problems
    generate(cases, gateway, kb, tmp_dir, materials, manifest["evaluation_file_sha256"], manifest["set"])
    return compare_dirs(out_dir, tmp_dir, manifest["cases"])


# ---------------------------------------------------------------- KB coverage

TABLE_CITATION = "S01 Table 1 (p.6)"


def _source_pages(kb: KnowledgeBase) -> list[str]:
    pages = []
    for src_dir in sorted(p for p in (kb.root / "pages").iterdir() if p.is_dir()):
        nums = sorted({int(f.stem[1:]) for f in src_dir.glob("p*.*") if f.stem[1:].isdigit()})
        pages += [f"{src_dir.name} p.{n}" for n in nums]
        if src_dir.name == "S01":
            pages.append(TABLE_CITATION)
    return pages


def _output_citations(kb: KnowledgeBase, outputs_dir: Path) -> dict[str, set[str]]:
    cited: dict[str, set[str]] = defaultdict(set)
    if not Path(outputs_dir).is_dir():
        return cited
    for f in sorted(Path(outputs_dir).glob("*.json")):
        if f.name in _SKIP_JSON:
            continue
        data = json.loads(f.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or "sources" not in data:
            continue
        for src in data["sources"]:
            card = kb.cards.get(src.get("id", ""))
            cited[card.citation() if card else src.get("citation", "")].add(data.get("case_id", f.stem))
    return cited


def kb_coverage(kb: KnowledgeBase, outputs_dir: Path = Path("outputs")) -> str:
    cards: dict[str, list[str]] = defaultdict(list)
    for card in kb.cards.values():
        if card.source != "EXT":
            cards[card.citation()].append(card.id)
    rules: dict[str, set[str]] = defaultdict(set)
    for rule_id, meta in kb.rules_meta.items():
        for cid in meta.get("sources", []):
            if cid in kb.cards:
                rules[kb.cards[cid].citation()].add(rule_id)
    cases = _output_citations(kb, outputs_dir)
    pages = _source_pages(kb)
    lines = ["# Knowledge-base coverage", "",
             f"Generated by `make coverage` from `kb/` (version {kb.version}) and `{Path(outputs_dir).as_posix()}/`.",
             "S05/S06 are business context only.", "",
             "| Page | Cards | Rules citing it | Output cases citing it |", "|---|---|---|---|"]
    for page in pages:
        lines.append(f"| {page} | {len(cards.get(page, []))} | {', '.join(sorted(rules.get(page, ()))) or '—'} | "
                     f"{', '.join(sorted(cases.get(page, ()))) or '—'} |")
    unused = [p for p in pages if not cards.get(p) and not cases.get(p)]
    uncited = [p for p in pages if cards.get(p) and not cases.get(p)]
    lines += ["", "## Pages never used", "", "No card and no output case cites these pages.", ""]
    lines += [f"- {p}" for p in unused] or ["- none"]
    lines += ["", "## Pages with cards but not cited by any output case", ""]
    lines += [f"- {p}" for p in uncited] or ["- none"]
    externals = sorted(c.id for c in kb.cards.values() if c.source == "EXT")
    lines += ["", f"External cards: {len(externals)}.", ""]
    return "\n".join(lines)
