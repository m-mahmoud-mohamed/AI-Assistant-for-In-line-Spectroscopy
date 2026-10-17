from pathlib import Path

from prism.cases import (
    EVAL_TXT,
    file_sha256,
    load_cases,
    load_dev_cases,
    load_eval_cases,
    load_worked_examples,
    sha256_text,
)

MAT = Path(__file__).resolve().parents[1] / "materials"


def test_dev_cases_are_d01_to_d08():
    cases = load_dev_cases(MAT)
    assert [c.case_id for c in cases] == [f"D0{i}" for i in range(1, 9)]
    assert cases[0].text.startswith("We manufacture tablets")
    assert all(c.sha256 == sha256_text(c.text) and c.origin == "case_file" for c in cases)


def test_worked_examples_d01_d02():
    ex = load_worked_examples(MAT)
    assert set(ex) == {"D01", "D02"}
    assert "Decision status" in ex["D01"] and "Sources" in ex["D02"]


def test_eval_cases_are_verbatim_and_hashed():
    raw = (MAT / EVAL_TXT).read_text(encoding="utf-8")
    cases = load_eval_cases(MAT)
    assert [c.case_id for c in cases] == [f"H0{i}" for i in range(1, 7)]
    for c in cases:
        assert c.text and c.text in raw and "=====" not in c.text
        assert c.sha256 == sha256_text(c.text)


def test_eval_file_fingerprint():
    assert file_sha256(MAT / EVAL_TXT).startswith("53903aea")


def test_load_cases_all():
    assert len(load_cases(MAT, "all")) == 14
