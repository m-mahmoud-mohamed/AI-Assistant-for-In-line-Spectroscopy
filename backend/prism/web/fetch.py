"""Fetch a URL and extract plain text: HTML with lxml (scripts, styles, navigation and hidden text removed),
PDF with PyMuPDF. Everything extracted is untrusted data."""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field

import fitz
from lxml import etree, html

from prism.web.config import WebConfig
from prism.web.http import HttpClient, Response

PDF_MAX_PAGES = 40
_DROP = ("script", "style", "noscript", "nav", "header", "footer", "aside", "form", "svg", "iframe", "template",
         "button", "select", "dialog", "canvas", "object", "embed")
_BLOCK = ("p", "div", "br", "li", "ul", "ol", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article",
          "table", "blockquote", "pre", "dt", "dd", "figcaption", "caption", "main")
_HIDDEN = re.compile(r"display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px|pt|em|rem|%)?\s*(?:;|$)|"
                     r"opacity\s*:\s*0(?:\.0+)?\s*(?:;|$)", re.IGNORECASE)


@dataclass
class Document:
    url: str
    final_url: str = ""
    ok: bool = False
    text: str = ""
    titles: list[str] = field(default_factory=list)      # <title>, og:title, h1: what the page calls itself
    content_type: str = ""
    sha256: str = ""
    retrieved_at: str = ""
    error: str = ""
    cached: bool = False


def _hidden(el) -> bool:
    if el.get("hidden") is not None or el.get("aria-hidden") == "true":
        return True
    return bool(_HIDDEN.search(el.get("style") or ""))


def html_to_text(body: bytes) -> tuple[str, list[str]]:
    parser = html.HTMLParser(remove_comments=True, remove_pis=True)
    try:
        root = html.document_fromstring(body, parser=parser)
    except (etree.ParserError, ValueError):
        return "", []
    titles = [t.strip() for t in root.xpath("//title/text()") if t.strip()]
    titles += [m.strip() for m in root.xpath("//meta[@property='og:title' or @name='citation_title' "
                                              "or @name='dc.title']/@content") if m.strip()]
    titles += [" ".join(h.text_content().split()) for h in root.xpath("//h1")[:3]]
    for el in root.xpath("//*[@hidden or @aria-hidden='true' or @style]"):
        if el.getparent() is not None and _hidden(el):
            _remove(el)
    for tag in _DROP:
        for el in root.xpath(f"//{tag}"):
            _remove(el)
    for el in root.iter(*_BLOCK):
        el.tail = "\n" + (el.tail or "")
    text = root.text_content()
    return re.sub(r"[ \t\r\f\v]+", " ", re.sub(r"\n\s*\n+", "\n", text)).strip(), titles


def _remove(el) -> None:
    parent = el.getparent()
    if parent is None:
        return
    tail = el.tail or ""
    prev = el.getprevious()
    if prev is not None:
        prev.tail = (prev.tail or "") + tail
    else:
        parent.text = (parent.text or "") + tail
    parent.remove(el)


def pdf_to_text(body: bytes) -> tuple[str, list[str]]:
    if not body.startswith(b"%PDF"):
        return "", []
    try:
        with fitz.open(stream=body, filetype="pdf") as pdf:
            pages = [pdf[i].get_text("text") for i in range(min(len(pdf), PDF_MAX_PAGES))]
            meta_title = (pdf.metadata or {}).get("title") or ""
    except Exception:  # noqa: BLE001 - corrupt PDFs are an unreachable source, not a crash
        return "", []
    text = "\n".join(pages)
    first = next((ln.strip() for ln in (pages[0] if pages else "").splitlines() if len(ln.strip()) > 15), "")
    return text.strip(), [t for t in (meta_title.strip(), first) if t]


class Fetcher:
    def __init__(self, http: HttpClient, cfg: WebConfig):
        self.http, self.cfg = http, cfg

    def fetch(self, url: str) -> Document:
        r: Response = self.http.get(url, page=True)
        doc = Document(url=url, final_url=r.url or url, content_type=r.content_type, retrieved_at=r.retrieved_at,
                       error=r.error, cached=r.cached)
        if not r.ok:
            return doc
        if r.content_type == "application/pdf" or r.body.startswith(b"%PDF"):
            doc.text, doc.titles = pdf_to_text(r.body)
        elif r.content_type in ("text/html", "application/xhtml+xml", ""):
            doc.text, doc.titles = html_to_text(r.body)
        else:
            doc.text = r.body.decode("utf-8", "replace")
        if not doc.text.strip():
            doc.error = doc.error or "no_text"
            return doc
        doc.ok, doc.sha256 = True, hashlib.sha256(r.body).hexdigest()
        return doc
