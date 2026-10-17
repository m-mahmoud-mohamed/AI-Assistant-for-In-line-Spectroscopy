"""Provider-agnostic web search. Default providers need no API key and return scholarly records
(OpenAlex, Crossref, Europe PMC); SearXNG, Tavily and Brave are enabled by environment variables."""
from __future__ import annotations

import logging
import os
import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from pydantic import BaseModel, Field

from prism.web.config import WebConfig
from prism.web.http import HttpClient

log = logging.getLogger(__name__)

_TAG = re.compile(r"<[^>]+>")
_SPACE = re.compile(r"\s+")
_TRACKING = re.compile(r"^(utm_|fbclid|gclid|mc_|ref$|ref_)")
_DOI = re.compile(r"10\.\d{4,9}/[^\s\"<>]+", re.IGNORECASE)


class SearchResult(BaseModel):
    title: str = ""
    url: str
    doi: str | None = None
    snippet: str = ""
    abstract: str = ""                 # full abstract from a scholarly API; counts as fetched text
    provider: str = ""
    providers: list[str] = Field(default_factory=list)
    year: int | None = None
    work_type: str = ""

    def brief(self) -> dict:
        return {"title": self.title, "url": self.url, "doi": self.doi, "year": self.year,
                "snippet": (self.snippet or self.abstract)[:300], "provider": self.provider}


def clean_text(text: str | None) -> str:
    return _SPACE.sub(" ", _TAG.sub(" ", text or "")).strip()


def normalise_doi(doi: str | None) -> str | None:
    if not doi:
        return None
    m = _DOI.search(doi)
    return m.group(0).rstrip(".,;)").lower() if m else None


def url_key(url: str) -> str:
    parts = urlsplit(url.strip())
    host = (parts.hostname or "").lower()
    host = host.removeprefix("www.")
    query = urlencode(sorted((k, v) for k, v in parse_qsl(parts.query) if not _TRACKING.match(k)))
    return urlunsplit(("https", host, parts.path.rstrip("/"), query, ""))


def dedupe_key(r: SearchResult) -> str:
    return f"doi:{r.doi}" if r.doi else f"url:{url_key(r.url)}"


def merge(ranked: list[list[SearchResult]]) -> list[SearchResult]:
    """Reciprocal-rank fusion over several result lists; duplicates (same DOI or URL) are merged."""
    merged: dict[str, SearchResult] = {}
    scores: dict[str, float] = {}
    for results in ranked:
        for rank, r in enumerate(results):
            key = dedupe_key(r)
            scores[key] = scores.get(key, 0.0) + 1.0 / (60 + rank + 1)
            have = merged.get(key)
            if have is None:
                merged[key] = r.model_copy(update={"providers": [r.provider]})
                continue
            if r.provider and r.provider not in have.providers:
                have.providers.append(r.provider)
            for name in ("title", "snippet", "abstract", "work_type"):
                if not getattr(have, name) and getattr(r, name):
                    setattr(have, name, getattr(r, name))
            have.year = have.year or r.year
            have.doi = have.doi or r.doi
    return [merged[k] for k in sorted(merged, key=lambda k: (-scores[k], k))]


# ---------------------------------------------------------------- providers

class Provider:
    name = ""

    def __init__(self, http: HttpClient, cfg: WebConfig):
        self.http, self.cfg = http, cfg

    def search(self, query: str, limit: int) -> list[SearchResult]:
        raise NotImplementedError

    def _json(self, url: str, params: dict | None = None, headers: dict | None = None):
        r = self.http.get(url, params=params, headers=headers, max_bytes=2_000_000, types=("application/json",))
        if not r.ok:
            if r.error != "replay_miss":
                log.info("%s: %s %s", self.name, url, r.error)
            return None
        try:
            return r.json()
        except ValueError:
            return None


def _doi_url(doi: str) -> str:
    return f"https://doi.org/{doi}"


class OpenAlex(Provider):
    name = "openalex"
    URL = "https://api.openalex.org/works"

    @staticmethod
    def abstract(index: dict | None) -> str:
        if not index:
            return ""
        words: dict[int, str] = {}
        for word, positions in index.items():
            for p in positions:
                words[p] = word
        return " ".join(words[i] for i in sorted(words))

    def search(self, query: str, limit: int) -> list[SearchResult]:
        params = {"search": query, "per-page": limit, "filter": "has_abstract:true",
                  "select": "id,doi,title,publication_year,type,abstract_inverted_index,primary_location"}
        if self.cfg.mailto:
            params["mailto"] = self.cfg.mailto
        data = self._json(self.URL, params)
        out = []
        for w in (data or {}).get("results", []):
            doi = normalise_doi(w.get("doi"))
            landing = ((w.get("primary_location") or {}).get("landing_page_url")) or ""
            url = _doi_url(doi) if doi else landing
            if not url or not w.get("title"):
                continue
            out.append(SearchResult(title=clean_text(w["title"]), url=url, doi=doi,
                                    abstract=self.abstract(w.get("abstract_inverted_index")), provider=self.name,
                                    year=w.get("publication_year"), work_type=w.get("type") or ""))
        return out


class Crossref(Provider):
    name = "crossref"
    URL = "https://api.crossref.org/works"

    def search(self, query: str, limit: int) -> list[SearchResult]:
        params = {"query": query, "rows": limit,
                  "select": "DOI,title,abstract,issued,URL,type,container-title",
                  "filter": "has-abstract:true"}
        if self.cfg.mailto:
            params["mailto"] = self.cfg.mailto
        data = self._json(self.URL, params)
        out = []
        for w in ((data or {}).get("message") or {}).get("items", []):
            doi = normalise_doi(w.get("DOI"))
            title = clean_text((w.get("title") or [""])[0])
            if not doi or not title:
                continue
            year = ((w.get("issued") or {}).get("date-parts") or [[None]])[0][0]
            out.append(SearchResult(title=title, url=_doi_url(doi), doi=doi, abstract=clean_text(w.get("abstract")),
                                    provider=self.name, year=year, work_type=w.get("type") or ""))
        return out


class EuropePMC(Provider):
    name = "europepmc"
    URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"

    def search(self, query: str, limit: int) -> list[SearchResult]:
        params = {"format": "json", "resultType": "core", "query": query, "pageSize": limit}
        data = self._json(self.URL, params)
        out = []
        for w in ((data or {}).get("resultList") or {}).get("result", []):
            doi = normalise_doi(w.get("doi"))
            title = clean_text(w.get("title"))
            if not title:
                continue
            url = _doi_url(doi) if doi else f"https://europepmc.org/article/{w.get('source')}/{w.get('id')}"
            year = int(w["pubYear"]) if str(w.get("pubYear", "")).isdigit() else None
            kind = "preprint" if "preprint" in str(w.get("pubType", "")).lower() or w.get("source") == "PPR" else (
                str(w.get("pubType") or ""))
            out.append(SearchResult(title=title, url=url, doi=doi, abstract=clean_text(w.get("abstractText")),
                                    provider=self.name, year=year, work_type=kind))
        return out


class SearXNG(Provider):
    name = "searxng"

    def search(self, query: str, limit: int) -> list[SearchResult]:
        base = os.environ.get("PRISM_SEARXNG_URL", "").rstrip("/")
        data = self._json(f"{base}/search", {"q": query, "format": "json"}) if base else None
        return [SearchResult(title=clean_text(w.get("title")), url=w["url"], doi=normalise_doi(w["url"]),
                             snippet=clean_text(w.get("content")), provider=self.name)
                for w in ((data or {}).get("results") or [])[:limit] if w.get("url")]


class Tavily(Provider):
    name = "tavily"
    URL = "https://api.tavily.com/search"

    def search(self, query: str, limit: int) -> list[SearchResult]:
        key = os.environ.get("TAVILY_API_KEY", "")
        if not key:
            return []
        r = self.http.post_json(self.URL, {"query": query, "max_results": limit, "search_depth": "basic"},
                                headers={"Authorization": f"Bearer {key}"}, cache_body={"query": query, "n": limit})
        if not r.ok:
            return []
        try:
            data = r.json()
        except ValueError:
            return []
        return [SearchResult(title=clean_text(w.get("title")), url=w["url"], doi=normalise_doi(w["url"]),
                             snippet=clean_text(w.get("content")), provider=self.name)
                for w in data.get("results", []) if w.get("url")]


class Brave(Provider):
    name = "brave"
    URL = "https://api.search.brave.com/res/v1/web/search"

    def search(self, query: str, limit: int) -> list[SearchResult]:
        key = os.environ.get("BRAVE_API_KEY", "")
        if not key:
            return []
        data = self._json(self.URL, {"q": query, "count": limit},
                          headers={"X-Subscription-Token": key, "Accept": "application/json"})
        return [SearchResult(title=clean_text(w.get("title")), url=w["url"], doi=normalise_doi(w["url"]),
                             snippet=clean_text(w.get("description")), provider=self.name)
                for w in ((data or {}).get("web") or {}).get("results", [])[:limit] if w.get("url")]


PROVIDERS: dict[str, type[Provider]] = {p.name: p for p in (OpenAlex, Crossref, EuropePMC, SearXNG, Tavily, Brave)}


class WebSearch:
    def __init__(self, http: HttpClient, cfg: WebConfig, providers: list[Provider] | None = None):
        self.http, self.cfg = http, cfg
        self.providers = providers if providers is not None else [
            PROVIDERS[n](http, cfg) for n in cfg.providers if n in PROVIDERS and cfg.provider_enabled(n)]

    def search(self, queries: str | list[str], limit: int | None = None) -> list[SearchResult]:
        """Every enabled provider answers every query; lists are fused, de-duplicated by DOI / URL, capped."""
        queries = [queries] if isinstance(queries, str) else list(queries)
        ranked: list[list[SearchResult]] = []
        for q in queries:
            for provider in self.providers:
                try:
                    ranked.append(provider.search(q, self.cfg.results_per_query))
                except Exception as exc:  # noqa: BLE001 - one failing provider never fails the search
                    log.warning("web provider %s failed: %s", provider.name, exc)
        return merge(ranked)[: limit or self.cfg.max_results]
