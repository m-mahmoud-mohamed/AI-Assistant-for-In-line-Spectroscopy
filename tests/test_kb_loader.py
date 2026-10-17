import shutil
from pathlib import Path

import pytest
import yaml

from prism.kb.loader import KBError, load_kb, quote_found
from prism.units import Range

KB = Path(__file__).resolve().parents[1] / "kb"


def test_real_kb_loads_with_verified_quotes():
    kb = load_kb(KB)
    assert len([c for c in kb.cards.values() if c.source != "TABLE"]) >= 52
    assert len([c for c in kb.cards.values() if c.source == "TABLE"]) == 19
    assert kb.card("S01-p10-nir-range").citation() == "S01 p.10"


def test_ranges():
    kb = load_kb(KB)
    assert kb.method_range("MIR") == Range(2.5, 25.0)
    assert kb.fiber_range("visnir_silica").overlap(kb.method_range("MIR")) is None
    assert kb.fiber_range("cir").overlap(kb.method_range("MIR")) == Range(2.5, 6.5)


def test_lexicon_contains_ambiguous_ir_and_scope_signals():
    lex = load_kb(KB).lexicon
    assert lex["ambiguous"]["ir"] == ["NIR", "MIR"]
    assert "ignore your instructions" in lex["scope_signals"]["unsafe"]


def test_quote_found_tolerates_whitespace_and_case():
    assert quote_found("NIR  spectra (780–2500 nm)", "... nir spectra (780–2500 nm) contain ...")
    assert not quote_found("completely different words", "nir spectra")


def _copy(tmp_path):
    root = tmp_path / "kb"
    shutil.copytree(KB, root, ignore=shutil.ignore_patterns("page_images", ".index"))
    return root


def test_bad_quote_is_rejected(tmp_path):
    root = _copy(tmp_path)
    bad = [{"id": "BAD-1", "source": "S01", "page": 10, "quote": "this sentence is not in the source",
            "claim": "x", "scope": "method_general", "status": "accepted"}]
    (root / "cards" / "bad.yaml").write_text(yaml.safe_dump(bad), encoding="utf-8")
    with pytest.raises(KBError, match="BAD-1"):
        load_kb(root)


def test_missing_reference_is_rejected(tmp_path):
    root = _copy(tmp_path)
    methods = yaml.safe_load((root / "graph/methods.yaml").read_text(encoding="utf-8"))
    methods[0]["range_cards"].append("NO-SUCH-CARD")
    (root / "graph/methods.yaml").write_text(yaml.safe_dump(methods), encoding="utf-8")
    with pytest.raises(KBError, match="NO-SUCH-CARD"):
        load_kb(root)


def test_version_changes_with_content(tmp_path):
    root = _copy(tmp_path)
    v1 = load_kb(root).version
    (root / "lexicon.yaml").write_text((root / "lexicon.yaml").read_text(encoding="utf-8") + "\n# edit\n",
                                       encoding="utf-8")
    assert load_kb(root).version != v1
