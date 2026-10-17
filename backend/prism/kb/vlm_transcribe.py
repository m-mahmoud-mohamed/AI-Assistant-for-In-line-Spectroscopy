"""Transcribe image-only S02 slides with the vision role. Output needs domain-expert review."""
from __future__ import annotations

import base64
from pathlib import Path

import fitz

from prism.kb.ingest import SOURCES
from prism.llm.prompts import render


def transcribe_slides(gateway, materials: Path, kb: Path, pages: list[int] | None = None,
                      force: bool = False) -> list[Path]:
    doc = fitz.open(Path(materials) / SOURCES["S02"])
    written = []
    for i, page in enumerate(doc, start=1):
        if pages and i not in pages:
            continue
        target = Path(kb) / "pages" / "S02" / f"p{i:02d}.md"
        if target.exists() and not force:
            continue
        b64 = base64.b64encode(page.get_pixmap(dpi=150).tobytes("png")).decode()
        prompt, phash = render("vlm_slide.j2", slide=i)
        res = gateway.complete("vision", [{"role": "user", "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}}]}])
        front = (f"---\nsource: S02\npage: {i}\ntranscribed_by: {res.model}\nprompt_hash: {phash}\n"
                 f"reviewed_by: pending-domain-expert\nreview_status: draft\n---\n")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(front + res.text.strip() + "\n", encoding="utf-8")
        written.append(target)
    return written


if __name__ == "__main__":
    from prism.llm.gateway import build_gateway
    for p in transcribe_slides(build_gateway(), Path("materials"), Path("kb")):
        print("wrote", p)
