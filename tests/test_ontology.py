"""kb/ontology.yaml: every question the clarify gate can ask is well formed, and every option is an engine input."""
from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from prism.assist.clarify import apply_confirmed, load_ontology
from prism.rules.engine import CF_DOMAINS, PLAN_SLOTS, evaluate
from prism.schemas import CERTAINTY, DISTANCE, DOMAINS, MATRIX, OPTICS, USE_CONTEXT
from tests.factories import make_sheet

KB = Path(__file__).resolve().parents[1] / "kb"
ENUMS = {"streams.*.matrix": MATRIX, "streams.*.optics": OPTICS, "distance": DISTANCE, "use_context": USE_CONTEXT,
         "requested_certainty": CERTAINTY, "domain": DOMAINS}


@pytest.fixture(scope="module")
def onto():
    return load_ontology(KB)


def concrete(slot: str) -> str:
    return slot.replace("streams.*.", "streams.s1.")


def test_every_entry_is_complete(onto):
    assert onto.specs
    for spec in onto.specs:
        assert spec.text.strip() and spec.why.strip(), spec.slot
        if spec.slot != "term:*":
            assert 2 <= len(spec.options) <= 5, spec.slot
            assert len({o.value for o in spec.options}) == len(spec.options), spec.slot
            assert all(o.label.strip() and o.prior > 0 for o in spec.options), spec.slot
    assert len({s.slot for s in onto.specs}) == len(onto.specs)


def test_every_option_is_an_engine_input(onto, kb):
    sheet = make_sheet(matrix="unknown", optics="unknown")
    for spec in onto.specs:
        if spec.slot == "term:*":
            continue
        for value in spec.allowed:
            if spec.slot in ENUMS:
                assert value in ENUMS[spec.slot], (spec.slot, value)
            hypo = apply_confirmed(sheet, {concrete(spec.slot): value})        # raises on a value the sheet rejects
            evaluate(hypo, kb)


def test_the_slots_the_engine_asks_about_have_an_entry(onto):
    have = {s.slot for s in onto.specs}
    assert {f"streams.*.{k}" if k in ("matrix", "optics") else k for k in CF_DOMAINS} <= have
    assert set(PLAN_SLOTS) <= have
    assert "term:*" in have and "streams.*.targets" in have


def test_rule_ids_and_method_labels_exist(onto, kb):
    rules = {r["id"] for r in yaml.safe_load((KB / "rules.yaml").read_text(encoding="utf-8"))}
    for spec in onto.specs:
        assert set(spec.reads) <= rules and set(spec.replaces) <= rules, spec.slot
    assert set(onto.risks) <= rules
    assert set(onto.methods) <= set(kb.methods)


def test_a_missing_file_asks_nothing(tmp_path):
    assert load_ontology(tmp_path).specs == ()


def test_the_ontology_is_part_of_the_kb_version(tmp_path):
    from prism.kb.loader import _hash_tree
    (tmp_path / "rules.yaml").write_text("[]", encoding="utf-8")
    before = _hash_tree(tmp_path)
    (tmp_path / "ontology.yaml").write_text("slots: []", encoding="utf-8")
    assert _hash_tree(tmp_path) != before
