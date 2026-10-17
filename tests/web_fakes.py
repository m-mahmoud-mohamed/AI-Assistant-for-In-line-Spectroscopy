"""An in-memory internet for the web tests: scholarly APIs and pages behind httpx.MockTransport. No network."""
from __future__ import annotations

import json
from pathlib import Path

import fitz
import httpx

from prism.llm.cache import LLMCache
from prism.web import WebService
from prism.web.config import load_web_config
from prism.web.http import HttpClient

ROOT = Path(__file__).resolve().parents[1]

ABSTRACT_GOOD = ("Near-infrared spectroscopy was applied in-line to monitor the blend uniformity of a powder "
                 "mixture during mixing. The probe was mounted flush with the vessel wall and spectra were "
                 "recorded every few seconds without sampling.")
QUOTE_GOOD = "The probe was mounted flush with the vessel wall and spectra were recorded every few seconds"
CLAIM_GOOD = "An in-line NIR probe was mounted flush with the vessel wall to record spectra during mixing."
TITLE_GOOD = "In-line near-infrared monitoring of powder blend uniformity"
DOI_GOOD = "10.1000/blend.2022.1"


def oa_work(title: str, doi: str, abstract: str, year: int = 2022, kind: str = "article") -> dict:
    index: dict[str, list[int]] = {}
    for pos, word in enumerate(abstract.split()):
        index.setdefault(word, []).append(pos)
    return {"id": f"https://openalex.org/W{abs(hash(doi)) % 10**6}", "doi": f"https://doi.org/{doi}", "title": title,
            "publication_year": year, "type": kind, "abstract_inverted_index": index,
            "primary_location": {"landing_page_url": f"https://doi.org/{doi}"}}


def cr_item(title: str, doi: str, abstract: str = "", year: int = 2022, kind: str = "journal-article") -> dict:
    item = {"DOI": doi, "title": [title], "issued": {"date-parts": [[year]]}, "type": kind,
            "URL": f"https://doi.org/{doi}"}
    if abstract:
        item["abstract"] = f"<jats:p>{abstract}</jats:p>"
    return item


def html_page(title: str, body: str, extra: str = "") -> bytes:
    return (f"<html><head><title>{title}</title><script>var secret='SCRIPT-TEXT';</script>"
            f"<style>.x{{color:red}}</style></head><body><nav>NAV-MENU Home Products</nav>"
            f"<h1>{title}</h1><article><p>{body}</p></article>{extra}<footer>FOOTER-TEXT</footer></body></html>"
            ).encode()


def pdf_bytes(text: str) -> bytes:
    doc = fitz.open()
    page = doc.new_page()
    y = 72
    for line in text.split("\n"):
        page.insert_text((72, y), line, fontsize=10)
        y += 14
    data = doc.tobytes()
    doc.close()
    return data


class FakeInternet:
    """Callable httpx handler. `calls` lists every request URL, so tests can assert what was (not) contacted."""

    def __init__(self):
        self.pages: dict[str, tuple[str, bytes]] = {}          # url -> (content type, body)
        self.openalex: list[dict] = []
        self.crossref: list[dict] = []
        self.europepmc: list[dict] = []
        self.doi_records: dict[str, dict] = {}                 # doi -> Crossref work
        self.redirects: dict[str, str] = {}
        self.calls: list[str] = []

    def add_doi(self, title: str, doi: str, abstract: str, year: int = 2022, kind: str = "journal-article") -> None:
        self.openalex.append(oa_work(title, doi, abstract, year, "article" if kind == "journal-article" else kind))
        self.doi_records[doi] = cr_item(title, doi, abstract, year, kind)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.calls.append(url)
        host, path = request.url.host, request.url.path
        if url in self.redirects:
            return httpx.Response(302, headers={"location": self.redirects[url]})
        if host == "api.openalex.org" and path == "/works":
            return httpx.Response(200, json={"results": self.openalex})
        if host == "api.crossref.org" and path == "/works":
            return httpx.Response(200, json={"message": {"items": self.crossref}})
        if host == "www.ebi.ac.uk":
            return httpx.Response(200, json={"resultList": {"result": self.europepmc}})
        if host == "api.crossref.org" and path.startswith("/works/"):
            rec = self.doi_records.get(path[len("/works/"):])
            return httpx.Response(200, json={"message": rec}) if rec else httpx.Response(404, json={})
        if host == "api.openalex.org" and path.startswith("/works/doi:"):
            return httpx.Response(404, json={})
        key = url.split("?")[0]
        if key in self.pages:
            ctype, body = self.pages[key]
            return httpx.Response(200, content=body, headers={"content-type": ctype})
        return httpx.Response(404, text="not found", headers={"content-type": "text/html"})


def make_service(tmp_path: Path, fake: FakeInternet | None = None, replay: bool = False,
                 transport: httpx.BaseTransport | None = None) -> WebService:
    cfg = load_web_config(ROOT / "config" / "web.yaml")
    cache = LLMCache(Path(tmp_path) / "web", replay=replay)
    return WebService(cfg, HttpClient(cfg, cache, transport or httpx.MockTransport(fake or FakeInternet())))


def dump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False)
