from pathlib import Path

from prism.kb.ingest import normalise, read_table, table_cards, techniques_from_table, write_pages

ROOT = Path(__file__).resolve().parents[1]


def test_normalise_joins_hyphenation_and_whitespace():
    assert normalise("well-\n suited   for\n water") == "well-suited for water"


def test_page_counts(tmp_path):
    counts = write_pages(ROOT / "materials", tmp_path, render=False)
    assert counts == {"S01": 19, "S02": 20, "S03": 17, "S04": 6, "S05": 2}
    assert "780–2500 nm" in normalise((tmp_path / "pages/S01/p10.txt").read_text(encoding="utf-8"))


def test_techniques_from_table():
    techs = techniques_from_table(read_table(ROOT / "materials/AFS_method_comparison_table.xlsx"))
    by_id = {t["id"]: t for t in techs}
    assert len(techs) == 19 and len(by_id) == 19
    nir = by_id["nir_diffuse_reflection_probe"]
    assert nir["in_line"] and "powder" in nir["sample_types"] and nir["method"] == "NIR"
    assert by_id["mir_atr_probe"]["technique"] == "ATR probe"
    assert not by_id["nir_cuvette"]["in_line"]
    cards = table_cards(techs)
    assert cards[0]["source"] == "TABLE" and cards[0]["status"] == "accepted"
