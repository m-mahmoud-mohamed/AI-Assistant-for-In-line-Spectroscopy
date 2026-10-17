"""Live smoke test for verified web search: search, then verify one real quote and one fabricated quote.

Usage: python scripts/web_smoke.py [query]
Needs network access; skips quietly (exit 0) when there is none. Uses the keyless scholarly providers.
Prints no secrets. HTTP responses are cached under $PRISM_CACHE_DIR/web (default .prism_cache/web).
"""
from __future__ import annotations

import re
import sys

from prism.schemas import WebStatus
from prism.web import WebService

QUERY = "in-line NIR spectroscopy tablet blend uniformity"


def pick_quote(text: str) -> str | None:
    """A whole sentence of 60-300 characters from the middle of the text."""
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if 60 <= len(s.strip()) <= 300]
    return sentences[len(sentences) // 2] if sentences else None


def main(query: str = QUERY) -> int:
    web = WebService.default()
    results = web.search.search(query)
    if not results:
        print("SKIP: the search returned nothing (no network or providers unreachable)")
        return 0
    print(f"{len(results)} results for {query!r}; providers: "
          f"{sorted({p for r in results for p in r.providers})}")
    for r in results[:5]:
        print(f"  - {r.year} {r.title[:80]} <{r.url}> via {','.join(r.providers)}")
    source = next((r for r in results if r.abstract and pick_quote(r.abstract)), None)
    if source is None:
        print("SKIP: no result with a usable abstract")
        return 0
    quote = pick_quote(source.abstract)
    ok = web.verifier.verify(source, quote, "")
    print(f"verify real quote   -> {ok.status.value} ({ok.match_kind}, {ok.domain}, {ok.domain_tier}) "
          f"checks={ok.checks}")
    fake = web.verifier.verify(source, "The probe withstands temperatures above one thousand degrees Celsius.", "")
    print(f"verify fake quote   -> {fake.status.value} (quote_found={fake.checks['quote_found']})")
    blocked = web.verifier.verify(type(source)(title="x", url="https://www.reddit.com/r/nir/comments/1/x"), quote)
    print(f"verify blocked site -> {blocked.status.value}")
    good = (ok.status == WebStatus.VERIFIED and fake.status == WebStatus.UNVERIFIED
            and blocked.status == WebStatus.BLOCKED)
    print("SMOKE OK" if good else "SMOKE FAILED")
    return 0 if good else 1


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:2]))
