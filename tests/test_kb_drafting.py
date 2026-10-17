from pathlib import Path

import yaml

from prism.kb.draft_cards import draft_cards
from prism.kb.vlm_transcribe import transcribe_slides
from tests.fakes import FakeGateway

ROOT = Path(__file__).resolve().parents[1]


def test_draft_cards_drop_paraphrased_quotes(tmp_path):
    kb = tmp_path / "kb"
    (kb / "pages/S01").mkdir(parents=True)
    (kb / "pages/S01/p10.txt").write_text((ROOT / "kb/pages/S01/p10.txt").read_text(encoding="utf-8"),
                                          encoding="utf-8")
    gw = FakeGateway({"generator": [{"cards": [
        {"quote": "NIR spectra (780–2500 nm) contain predominantly overtones", "claim": "NIR range",
         "scope": "method_general", "methods": ["NIR"], "topics": ["spectral_range"]},
        {"quote": "NIR is always the best method", "claim": "invented", "scope": "method_general",
         "methods": ["NIR"], "topics": []}]}]})
    out = draft_cards(gw, kb, "S01", [10])
    cards = yaml.safe_load(out.read_text(encoding="utf-8"))
    assert out.parent.name == "drafts" and len(cards) == 1
    assert cards[0]["status"] == "draft" and cards[0]["id"] == "S01-p10-d1"


def test_transcribe_skips_existing_notes(tmp_path):
    kb = tmp_path / "kb"
    (kb / "pages/S02").mkdir(parents=True)
    (kb / "pages/S02/p06.md").write_text("reviewed", encoding="utf-8")
    gw = FakeGateway({"vision": ["Slide 7 text: Robust 100-300m cables"]})
    written = transcribe_slides(gw, ROOT / "materials", kb, pages=[6, 7])
    assert [p.name for p in written] == ["p07.md"]
    assert (kb / "pages/S02/p06.md").read_text(encoding="utf-8") == "reviewed"
    text = (kb / "pages/S02/p07.md").read_text(encoding="utf-8")
    assert "review_status: draft" in text and "Robust 100-300m cables" in text
    content = gw.requests[0]["messages"][0]["content"]
    assert content[1]["image_url"]["url"].startswith("data:image/png;base64,")
