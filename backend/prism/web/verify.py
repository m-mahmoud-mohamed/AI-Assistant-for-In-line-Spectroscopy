"""Source verification: can this quote be found, in this source, on a domain we accept?

Only a VERIFIED source may become evidence. Every check is deterministic (no LLM):
  reachable            the page was fetched, or the DOI resolves (Crossref / OpenAlex) and yields readable text
  quote_found          the quote occurs in the fetched text after whitespace / Unicode normalisation
                       (exact, or RapidFuzz partial_ratio >= threshold with identical numbers)
  domain_allowed       domain policy of config/web.yaml (blocklist, allowed trust tiers)
  metadata_consistent  the title of the page / DOI record matches the search result's title
  quote_length         30 to 400 characters
  claim_numbers_in_quote, no_injection_markers   defence in depth for the LLM-written claim
"""
from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass, field
from urllib.parse import quote as urlquote

from rapidfuzz import fuzz

from prism.schemas import Verification, WebStatus
from prism.web.config import WebConfig, host_of
from prism.web.fetch import Document, Fetcher
from prism.web.http import HttpClient, now_iso
from prism.web.search import SearchResult, clean_text, normalise_doi

FUZZY_CAP = 400_000                 # characters of text searched for a fuzzy match
HEAD_CHARS = 1500                   # start of the page, where a title is expected
_TRANSLATE = str.maketrans({
    "\u2019": "'", "\u2018": "'", "\u201c": '"', "\u201d": '"',          # typographic quotes
    "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-", "\u2212": "-",   # dashes, minus
    "\u00a0": " ", "\u00ad": "", "\u200b": "", "\u200c": "", "\u200d": "", "\ufeff": ""})  # nbsp, invisibles
_DEWRAP = re.compile(r"(?<=\w)- (?=\w)")
_NUMBER = re.compile(r"\d+(?:[.,]\d+)?")
_NOT_PEER_REVIEWED = ("preprint", "posted-content", "dataset", "report", "grant", "peer-review", "component", "other")
_INJECTION = re.compile(
    r"ignore (?:all |any |the |your )?(?:previous|prior|above|earlier)|disregard (?:all |any |the |your )?"
    r"(?:previous|prior|above|earlier|instructions?)|system prompt|new instructions?|you are (?:now )?(?:an? )?"
    r"(?:ai|assistant|language model|chatbot)|as an ai\b|(?:^|\s)(?:assistant|system)\s*:|<\s*/?\s*"
    r"(?:system|assistant|instructions?)\b|override (?:the )?(?:rules|guardrails)|respond only with",
    re.IGNORECASE)


def fold(text: str) -> str:
    """Unicode (NFKC: ligatures, full-width forms), typographic quotes and dashes, whitespace, case."""
    text = unicodedata.normalize("NFKC", text).translate(_TRANSLATE)
    return re.sub(r"\s+", " ", text).strip().casefold()


def dewrap(text: str) -> str:
    """Re-join words hyphenated at a line break ('spectro- scopy' -> 'spectroscopy')."""
    return _DEWRAP.sub("", text)


def numbers_in(text: str) -> list[str]:
    return [n.replace(",", ".") for n in _NUMBER.findall(text)]


def locate_quote(quote: str, text: str, threshold: float = 95.0) -> tuple[str, float]:
    """('exact' | 'fuzzy' | 'none', score). A fuzzy match must keep every number of the quote."""
    q = fold(quote)
    if not q:
        return "none", 0.0
    t = fold(text)
    if q in t:
        return "exact", 100.0
    qd, td = dewrap(q), dewrap(t)
    if qd in td:
        return "exact", 100.0
    window = td[:FUZZY_CAP]
    hit = fuzz.partial_ratio_alignment(qd, window, score_cutoff=threshold)
    if hit is None:
        return "none", 0.0
    around = window[max(0, hit.dest_start - 4): hit.dest_end + 4]
    have = numbers_in(around)
    if any(n not in have for n in numbers_in(qd)):
        return "none", hit.score          # same words but another number: not the same statement
    return "fuzzy", float(hit.score)


def _title_form(text: str) -> str:
    return re.sub(r"[\W_]+", " ", fold(text)).strip()


def _pair(a: str, b: str) -> float:
    if min(len(a), len(b)) >= 15:
        return max(fuzz.token_sort_ratio(a, b), fuzz.partial_ratio(a, b))
    return fuzz.ratio(a, b)


def title_score(expected: str, candidates: list[str], head: str = "") -> float:
    """Best match of the expected title against the titles a page / record gives itself, or its first lines."""
    e = _title_form(expected)
    if not e:
        return 100.0
    best = max((_pair(e, c) for c in map(_title_form, candidates) if c), default=0.0)
    h = _title_form(head)
    if h and len(e) >= 15:
        best = max(best, fuzz.partial_ratio(e, h))
    return float(best)


@dataclass
class DoiRecord:
    doi: str
    title: str = ""
    abstract: str = ""
    work_type: str = ""
    year: int | None = None


@dataclass
class Loaded:
    reachable: bool = False
    text: str = ""
    titles: list[str] = field(default_factory=list)
    sha256: str = ""
    retrieved_at: str = ""
    final_url: str = ""
    kind: str = "page"                 # page | doi
    work_type: str = ""
    notes: list[str] = field(default_factory=list)


@dataclass
class Inspection:
    host: str
    tier: str
    blocked: bool = False
    reason: str = ""
    loaded: Loaded | None = None


class DoiResolver:
    """Resolve a DOI to its metadata via Crossref, then OpenAlex (both keyless, both cached)."""

    def __init__(self, http: HttpClient, cfg: WebConfig):
        self.http, self.cfg = http, cfg

    def _json(self, url: str, params: dict | None = None):
        r = self.http.get(url, params=params, max_bytes=2_000_000, types=("application/json",))
        if not r.ok:
            return None
        try:
            return r.json()
        except ValueError:
            return None

    def resolve(self, doi: str) -> DoiRecord | None:
        doi = normalise_doi(doi) or ""
        if not doi:
            return None
        path = urlquote(doi, safe="/")
        params = {"mailto": self.cfg.mailto} if self.cfg.mailto else None
        data = self._json(f"https://api.crossref.org/works/{path}", params)
        msg = (data or {}).get("message") or {}
        if msg.get("title"):
            year = ((msg.get("issued") or {}).get("date-parts") or [[None]])[0][0]
            return DoiRecord(doi, clean_text(msg["title"][0]), clean_text(msg.get("abstract")),
                             msg.get("type") or "", year)
        data = self._json(f"https://api.openalex.org/works/doi:{path}", params)
        if data and data.get("title"):
            from prism.web.search import OpenAlex
            return DoiRecord(doi, clean_text(data["title"]), OpenAlex.abstract(data.get("abstract_inverted_index")),
                             data.get("type") or "", data.get("publication_year"))
        return None


class Verifier:
    def __init__(self, http: HttpClient, cfg: WebConfig, fetcher: Fetcher | None = None,
                 resolver: DoiResolver | None = None):
        self.http, self.cfg = http, cfg
        self.fetcher = fetcher or Fetcher(http, cfg)
        self.resolver = resolver or DoiResolver(http, cfg)

    # ------------------------------------------------------------------ loading

    def _load_doi(self, source: SearchResult) -> Loaded:
        rec = self.resolver.resolve(source.doi or "")
        if rec is None:
            return Loaded(notes=["DOI did not resolve via Crossref or OpenAlex"])
        texts = [t for t in dict.fromkeys([source.abstract, rec.abstract]) if t]
        loaded = Loaded(reachable=True, titles=[rec.title], work_type=rec.work_type or source.work_type,
                        kind="doi", retrieved_at=now_iso(), final_url=source.url)
        if not texts:                  # no abstract in the index: try the landing page
            doc = self.fetcher.fetch(source.url)
            if not doc.ok:
                loaded.reachable = False
                loaded.notes.append(f"DOI resolves but no abstract is indexed and the page is unreadable ({doc.error})")
                return loaded
            loaded.text, loaded.titles, loaded.sha256 = doc.text, [*loaded.titles, *doc.titles], doc.sha256
            loaded.final_url, loaded.kind = doc.final_url, "page"
            loaded.retrieved_at = doc.retrieved_at or loaded.retrieved_at
            return loaded
        loaded.text = "\n".join(texts)
        loaded.sha256 = hashlib.sha256(loaded.text.encode("utf-8")).hexdigest()
        loaded.notes.append("text is the abstract from the DOI record")
        return loaded

    def _load_page(self, source: SearchResult) -> Loaded:
        doc: Document = self.fetcher.fetch(source.url)
        if not doc.ok:
            return Loaded(final_url=doc.final_url, retrieved_at=doc.retrieved_at, notes=[f"not readable: {doc.error}"])
        return Loaded(reachable=True, text=doc.text, titles=doc.titles, sha256=doc.sha256,
                      retrieved_at=doc.retrieved_at or now_iso(), final_url=doc.final_url,
                      work_type=source.work_type)

    def inspect(self, source: SearchResult) -> Inspection:
        policy = self.cfg.policy
        host = host_of(source.url)
        ok, reason = policy.check(host)
        if not ok:
            return Inspection(host, policy.tier(host), blocked=True, reason=reason)
        loaded = self._load_doi(source) if source.doi else self._load_page(source)
        final_host = host_of(loaded.final_url) or host
        tier = policy.tier(final_host)
        if loaded.kind == "doi" or final_host == "doi.org":
            kind = (loaded.work_type or source.work_type).lower()
            if any(bad in kind for bad in _NOT_PEER_REVIEWED):
                tier = "general"
        ok, reason = policy.check(final_host, tier)
        return Inspection(final_host if loaded.kind == "page" else host, tier, blocked=not ok, reason=reason,
                          loaded=loaded)

    # ------------------------------------------------------------------ verification

    def verify(self, source: SearchResult, quote: str, claim: str = "",
               inspection: Inspection | None = None) -> Verification:
        cfg, insp = self.cfg, inspection or self.inspect(source)
        loaded = insp.loaded or Loaded()
        quote = " ".join((quote or "").split())
        checks = {"reachable": False, "quote_found": False, "domain_allowed": not insp.blocked,
                  "metadata_consistent": False, "quote_length": False, "claim_numbers_in_quote": False,
                  "no_injection_markers": False}
        notes = list(loaded.notes)

        def result(status: WebStatus, kind: str = "none", score: float = 0.0) -> Verification:
            return Verification(status=status, checks=checks, match_kind=kind, match_score=round(score, 1),
                                domain=insp.host, domain_tier=insp.tier, content_sha256=loaded.sha256,
                                retrieved_at=loaded.retrieved_at or now_iso(), url=source.url,
                                doi=source.doi, notes=notes)

        if insp.blocked:
            notes.append(insp.reason)
            return result(WebStatus.BLOCKED)
        checks["reachable"] = loaded.reachable
        if not loaded.reachable:
            return result(WebStatus.UNREACHABLE)
        checks["quote_length"] = cfg.quote_min_chars <= len(quote) <= cfg.quote_max_chars
        if not checks["quote_length"]:
            notes.append(f"quote has {len(quote)} characters; allowed {cfg.quote_min_chars}-{cfg.quote_max_chars}")
        checks["no_injection_markers"] = not _INJECTION.search(f"{quote} {claim}")
        if not checks["no_injection_markers"]:
            notes.append("quote or claim contains instruction-like text")
        checks["claim_numbers_in_quote"] = all(n in numbers_in(quote) for n in numbers_in(claim))
        if not checks["claim_numbers_in_quote"]:
            notes.append("the claim contains a number that is not in the quote")
        kind, score = locate_quote(quote, loaded.text, cfg.fuzzy_threshold) if quote else ("none", 0.0)
        checks["quote_found"] = kind != "none"
        if kind == "none":
            notes.append("quote not found in the fetched text")
        elif kind == "fuzzy":
            notes.append(f"quote matched with hyphenation / ligature noise (partial_ratio {score:.0f})")
        tscore = title_score(source.title, loaded.titles, "" if loaded.kind == "doi" else loaded.text[:HEAD_CHARS])
        checks["metadata_consistent"] = tscore >= cfg.title_threshold
        if not source.title:
            notes.append("no expected title given; title not compared")
        elif not checks["metadata_consistent"]:
            notes.append(f"title does not match the source (ratio {tscore:.0f} < {cfg.title_threshold:.0f})")
        status = WebStatus.VERIFIED if all(checks.values()) else WebStatus.UNVERIFIED
        return result(status, kind, score)
