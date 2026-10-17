"""Stage 3b (opt-in): search the web, read the best sources, keep only quotes that verify.

The page text is data. The extractor LLM may only *choose* a quote; code then checks that the quote really
occurs in the source (prism/web/verify.py). A card is created only for a VERIFIED source.
"""
from __future__ import annotations

import hashlib
import re
from collections.abc import Callable

from pydantic import BaseModel

from prism.llm.cache import ReplayMiss
from prism.llm.gateway import LLMUnavailable
from prism.llm.prompts import render
from prism.schemas import (
    DOMAINS,
    Card,
    RequirementsSheet,
    RuleFindings,
    Scope,
    Verification,
    WebReport,
    WebSourceRecord,
    WebStatus,
)
from prism.web import WebService
from prism.web.config import host_of
from prism.web.search import SearchResult
from prism.web.verify import fold

_DOMAIN_WORDS = {"pharma": "pharmaceutical", "dairy_food": "food dairy", "bioprocess": "bioprocess",
                 "petrochemical": "petrochemical", "polymer": "polymer", "medical": "medical",
                 "environmental": "environmental", "other": ""}
assert set(_DOMAIN_WORDS) == set(DOMAINS)
_METHOD_WORDS = {"NIR": r"\bNIR\b|near[- ]infrared", "MIR": r"\bMIR\b|mid[- ]infrared|\bFT-?IR\b|\bATR\b",
                 "Raman": r"\bRaman\b", "UV-Vis": r"UV[-/ ]?Vis|ultraviolet", "Fluorescence": r"fluorescen"}
_TIER_RANK = {"peer_reviewed": 0, "standards": 0, "vendor": 1, "general": 2}
_TOKEN = re.compile(r"[a-z0-9µ]+")
CLAIM_MAX = 300
EVENT = "web_source"


class WebQuote(BaseModel):
    relevant: bool = False
    quote: str | None = None
    claim: str | None = None


def _clean(text: str) -> str:
    return re.sub(r"[^\w\s\-/%.,µ]", " ", text).strip()


def build_queries(sheet: RequirementsSheet, findings: RuleFindings, limit: int = 3) -> list[str]:
    """At most `limit` queries from generic requirement terms only: targets, matrix, domain, candidate methods.
    The enquiry text, client names and quotes are never sent to a search engine."""
    targets = list(dict.fromkeys(t.name for s in sheet.streams for t in s.targets if t.defined))[:3]
    matrix = list(dict.fromkeys(s.matrix.value for s in sheet.streams if s.matrix.stated))[:2]
    domain = _DOMAIN_WORDS.get(sheet.domain, "")
    methods: list[str] = []
    for s in sheet.streams:
        methods += [c.method for c in findings.top(s.id, 2)]
    methods = list(dict.fromkeys(methods))[:2]
    subject = " ".join([*targets, *matrix, domain]).strip()
    queries = [f"in-line process spectroscopy {subject}".strip()]
    queries += [f"in-line {m} spectroscopy {subject}".strip() for m in methods]
    out = list(dict.fromkeys(" ".join(_clean(q).split()) for q in queries if q))
    return out[:limit]


def topic_of(sheet: RequirementsSheet, findings: RuleFindings) -> str:
    q = build_queries(sheet, findings, 1)
    return (q[0] if q else "in-line process spectroscopy")


def select_excerpt(text: str, topic: str, limit: int) -> str:
    """The most topical passages of a long text, in document order, within `limit` characters."""
    if len(text) <= limit:
        return text
    words = set(_TOKEN.findall(topic.lower())) - {"in", "line", "process", "of"}
    passages, cur = [], ""
    for line in text.splitlines():
        if len(cur) + len(line) > 1200 and cur:
            passages.append(cur)
            cur = ""
        cur += line + "\n"
    passages.append(cur)
    scored = sorted(range(len(passages)), key=lambda i: (-len(words & set(_TOKEN.findall(passages[i].lower()))), i))
    keep, used = [], 0
    for i in scored:
        if used + len(passages[i]) > limit:
            continue
        keep.append(i)
        used += len(passages[i])
    return "".join(passages[i] for i in sorted(keep)).strip()


def extractor_messages(topic: str, source: SearchResult, host: str, text: str, limit: int) -> list[dict]:
    excerpt = select_excerpt(text, topic, limit).replace("</source_text", "</ source_text")
    ident = hashlib.sha256(text.encode("utf-8")).hexdigest()[:8]
    system, _ = render("web_extract_system.j2")
    user, _ = render("web_extract_user.j2", topic=topic, title=source.title, domain=host, ident=ident,
                     excerpt=excerpt)
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def card_id(url: str, quote: str) -> str:
    return "EXT-" + hashlib.sha256(f"{url}|{fold(quote)}".encode()).hexdigest()[:10]


def make_card(source: SearchResult, quote: str, claim: str, v: Verification) -> Card:
    quote = " ".join(quote.split())
    claim = " ".join((claim or quote).split())[:CLAIM_MAX]
    methods = [m for m, pat in _METHOD_WORDS.items() if re.search(pat, f"{quote} {claim}", re.IGNORECASE)]
    return Card(id=card_id(source.url, quote), source="EXT", page=0, quote=quote, claim=claim,
                scope=Scope.external, methods=methods, status="web_verified", url=source.url,
                retrieved_at=v.retrieved_at, doi=source.doi, verification=v)


def run_web_stage(sheet: RequirementsSheet, findings: RuleFindings, gateway, web: WebService,
                  emit: Callable[..., None] | None = None) -> tuple[list[Card], WebReport]:
    cfg, verifier = web.cfg, web.verifier
    emit = emit or (lambda *a, **k: None)
    queries = build_queries(sheet, findings, cfg.max_queries)
    report = WebReport(enabled=True, queries=queries)
    if not queries:
        return [], report
    results = web.search.search(queries, cfg.max_results)
    report.considered = len(results)
    policy = cfg.policy
    results.sort(key=lambda r: _TIER_RANK[policy.tier(host_of(r.url))])        # stable: keeps the search ranking
    topic, cards, fetched = topic_of(sheet, findings), [], 0

    def record(src: SearchResult, v: Verification | None, reason: str = "", cid: str | None = None) -> None:
        report.sources.append(WebSourceRecord(title=src.title, url=src.url, doi=src.doi, provider=src.provider,
                                              year=src.year, verification=v, card_id=cid, reason=reason))
        emit(EVENT, "web", url=src.url, title=src.title, status=v.status.value if v else "SKIPPED",
             domain=v.domain if v else host_of(src.url), card_id=cid, reason=reason)

    for src in results:
        if len(cards) >= cfg.max_external_cards or fetched >= cfg.max_fetch:
            break
        if policy.is_blocked(host_of(src.url)):          # no request is made to a blocked domain
            record(src, verifier.verify(src, "", "", verifier.inspect(src)), "blocked domain")
            continue
        fetched += 1
        insp = verifier.inspect(src)
        if insp.blocked or insp.loaded is None or not insp.loaded.reachable:
            v = verifier.verify(src, "", "", insp)
            record(src, v, "; ".join(v.notes) or v.status.value.lower())
            continue
        try:
            res = gateway.complete("extractor", extractor_messages(topic, src, insp.host, insp.loaded.text,
                                                                  cfg.excerpt_chars),
                                   schema=WebQuote, reasoning="off")
        except (LLMUnavailable, ReplayMiss) as exc:
            record(src, None, f"quote extraction unavailable: {type(exc).__name__}")
            continue
        picked: WebQuote = res.parsed
        if not (picked.relevant and picked.quote):
            record(src, None, "no relevant passage")
            continue
        v = verifier.verify(src, picked.quote, picked.claim or "", insp)
        if v.status != WebStatus.VERIFIED:
            record(src, v, "; ".join(n for n in v.notes if "text is the abstract" not in n) or v.status.value.lower())
            continue
        card = make_card(src, picked.quote, picked.claim or "", v)
        if card.id in {c.id for c in cards}:
            record(src, v, "duplicate quote")
            continue
        cards.append(card)
        record(src, v, cid=card.id)
    return cards, report
