"""Build the citable page store and Table 1 graph from the supplied AFS materials.

Run: python -m prism.kb.ingest
Writes kb/pages/<S>/pNN.txt (PDF text layer, 1-based page numbers), kb/page_images/<S>/pNN.png,
kb/graph/techniques.yaml and kb/cards/table1.yaml. Never touches reviewed notes (kb/pages/**/pNN.md).
"""
from __future__ import annotations

import re
import unicodedata
from pathlib import Path

import fitz
import openpyxl
import yaml

SOURCES = {"S01": "S01_Multispectral_Laboratory.pdf", "S02": "S02_AFS_Process_Control_Slides.pdf",
           "S03": "S03_LED_Kidney_Study_2017.pdf", "S04": "S04_Combi_MIR_Fluorescence_2021.pdf",
           "S05": "S05_AFS_Flyer.pdf"}
METHOD_IDS = {"IR spectroscopy": "MIR", "NIR spectroscopy": "NIR", "Raman spectroscopy": "Raman",
              "UV/Visible spectroscopy": "UV-Vis", "Fluorimetry": "Fluorescence"}


def normalise(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    text = re.sub(r"-\s*\n\s*", "-", text)
    return re.sub(r"\s+", " ", text).strip()


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


def write_pages(materials: Path, kb: Path, render: bool = True, dpi: int = 110) -> dict[str, int]:
    counts = {}
    for sid, fname in SOURCES.items():
        doc = fitz.open(materials / fname)
        counts[sid] = len(doc)
        text_dir = kb / "pages" / sid
        text_dir.mkdir(parents=True, exist_ok=True)
        for i, page in enumerate(doc, start=1):
            (text_dir / f"p{i:02d}.txt").write_text(page.get_text(), encoding="utf-8")
            if render:
                img_dir = kb / "page_images" / sid
                img_dir.mkdir(parents=True, exist_ok=True)
                page.get_pixmap(dpi=dpi).save(str(img_dir / f"p{i:02d}.png"))
    return counts


def read_table(xlsx: Path) -> list[dict]:
    ws = openpyxl.load_workbook(xlsx, read_only=True, data_only=True).worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    header = [str(h) for h in rows[0]]
    out = []
    for r in rows[1:]:
        if r[0] is None or not str(r[0]).strip().isdigit():
            continue
        out.append(dict(zip(header, ["" if v is None else str(v).strip() for v in r])))
    return out


def techniques_from_table(rows: list[dict]) -> list[dict]:
    techs = []
    for r in rows:
        method = METHOD_IDS[r["method"]]
        name = r["measurement_technique"].rstrip("*").strip()
        tid = f"{slug(method)}_{slug(name)}"
        techs.append({
            "id": tid, "method": method, "technique": name, "phenomenon": r["physical_phenomenon"],
            "sample_types": [s.strip() for s in r["sample_type"].split(",")],
            "path_depth": r["optical_path_or_depth"], "sensitivity": r["sensitivity"],
            "selectivity": r["selectivity"], "cost": r["cost"],
            "in_line": "probe" in name.lower() or name.lower() == "surface at a distance",
            "card": f"TABLE-{tid}",
            "table_row": " | ".join(r[k] for k in ("method", "measurement_technique", "physical_phenomenon",
                                                   "sample_type", "optical_path_or_depth", "sensitivity",
                                                   "selectivity", "cost")),
        })
    return techs


def table_cards(techniques: list[dict]) -> list[dict]:
    return [{
        "id": t["card"], "source": "TABLE", "page": 6, "quote": t["table_row"],
        "claim": (f"{t['method']} {t['technique']}: {t['phenomenon']}; samples {', '.join(t['sample_types'])}; "
                  f"optical path/depth {t['path_depth']}; sensitivity {t['sensitivity']}, selectivity "
                  f"{t['selectivity']}, cost {t['cost']} (qualitative ratings of S01 Table 1)."),
        "scope": "method_general", "methods": [t["method"]], "topics": ["table1", "technique"],
        "status": "accepted",
    } for t in techniques]


def _dump(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True, width=120), encoding="utf-8")


def main() -> None:
    materials, kb = Path("materials"), Path("kb")
    counts = write_pages(materials, kb)
    techs = techniques_from_table(read_table(materials / "AFS_method_comparison_table.xlsx"))
    _dump(kb / "graph" / "techniques.yaml", techs)
    _dump(kb / "cards" / "table1.yaml", table_cards(techs))
    print(f"pages: {counts}; techniques: {len(techs)}")


if __name__ == "__main__":
    main()
