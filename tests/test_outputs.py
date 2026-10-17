import importlib.util
import json
from pathlib import Path

from prism.cases import load_cases
from prism.outputs import VOLATILE_KEYS, comparable, generate, kb_coverage
from prism.stages.checks import POLICY_IDS
from tests.factories import make_sheet
from tests.fakes import FakeGateway
from tests.test_orchestrator import OK_CRITIC, body

ROOT = Path(__file__).resolve().parents[1]
MAT = ROOT / "materials"


def _fake(n: int) -> FakeGateway:
    return FakeGateway({"extractor": [make_sheet().model_dump(mode="json") for _ in range(n)],
                        "generator_deep": [body() for _ in range(n)], "critic_deep": [OK_CRITIC] * n})


def _dev_cases():
    return load_cases(MAT, "dev")[:2]


def _script(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_write_case_index_compliance_manifest(kb, tmp_path):
    cases = _dev_cases()
    results = generate(cases, _fake(len(cases)), kb, tmp_path, MAT, input_file_sha="abc123", case_set="dev")
    assert len(results) == 2
    for c in cases:
        report = json.loads((tmp_path / f"{c.case_id}.json").read_text(encoding="utf-8"))
        assert report["case_id"] == c.case_id
        assert "## Direct answer" in (tmp_path / f"{c.case_id}.md").read_text(encoding="utf-8")
    index = (tmp_path / "index.md").read_text(encoding="utf-8")
    assert all(f"| {c.case_id} |" in index for c in cases) and "NIR" in index
    compliance = (tmp_path / "compliance.md").read_text(encoding="utf-8")
    assert all(pid in compliance for pid in POLICY_IDS) and "✅" in compliance
    manifest = json.loads((tmp_path / "run_manifest.json").read_text(encoding="utf-8"))
    assert manifest["evaluation_file_sha256"] == "abc123" and manifest["profile"] == "fake"
    assert manifest["set"] == "dev" and "git_commit" in manifest
    assert [m["case_id"] for m in manifest["manifests"]] == [c.case_id for c in cases]


def test_comparable_drops_only_volatile_keys():
    report = {"case_id": "D01", "created_at": "t", "run_id": "r", "git_commit": "abc",
              "manifests": [{"started_at": "a", "finished_at": "b", "timings": {"x": 1.0}, "profile": "p"}],
              "nested": {"timings": {}, "keep": [1, {"created_at": "z", "ok": True}]}}
    out = comparable(report)
    assert out == {"case_id": "D01", "run_id": "r", "manifests": [{"profile": "p"}],
                   "nested": {"keep": [1, {"ok": True}]}}
    assert set(VOLATILE_KEYS) == {"created_at", "started_at", "finished_at", "timings", "git_commit"}
    assert report["created_at"] == "t"          # input is not mutated


def test_verify_detects_manual_edit(kb, tmp_path, capsys):
    cases = _dev_cases()
    generate(cases, _fake(len(cases)), kb, tmp_path, MAT, input_file_sha="abc123", case_set="dev")
    verify = _script("verify_outputs")
    assert verify.main(["--out", str(tmp_path)], gateway=_fake(len(cases)), kb=kb, materials=MAT) == 0
    md = tmp_path / f"{cases[0].case_id}.md"
    md.write_text(md.read_text(encoding="utf-8") + "\nEdited by hand.\n", encoding="utf-8")
    assert verify.main(["--out", str(tmp_path)], gateway=_fake(len(cases)), kb=kb, materials=MAT) == 1
    assert "Edited by hand." in capsys.readouterr().out


def test_kb_coverage_lists_pages(kb, tmp_path):
    table = kb_coverage(kb, tmp_path)
    row = next(line for line in table.splitlines() if line.startswith("| S01 p.10 |"))
    assert int(row.split("|")[2]) >= 1
    assert "S01 Table 1 (p.6)" in table and "## Pages never used" in table
