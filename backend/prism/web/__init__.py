"""Verified web search: provider-agnostic search, safe fetching, deterministic source verification."""
from __future__ import annotations

import os
from pathlib import Path

import httpx
from dotenv import load_dotenv

from prism.llm.cache import LLMCache
from prism.web.config import WebConfig, load_web_config
from prism.web.fetch import Fetcher
from prism.web.http import HttpClient
from prism.web.search import SearchResult, WebSearch
from prism.web.verify import Verifier

__all__ = ["SearchResult", "WebConfig", "WebService"]


class WebService:
    """Everything the pipeline and the chat agent need from the web, behind one object."""

    def __init__(self, cfg: WebConfig, http: HttpClient, search: WebSearch | None = None,
                 verifier: Verifier | None = None):
        self.cfg, self.http = cfg, http
        self.search = search or WebSearch(http, cfg)
        self.verifier = verifier or Verifier(http, cfg)
        self.fetcher: Fetcher = self.verifier.fetcher

    @classmethod
    def default(cls, cache_dir: Path | str | None = None, replay: bool | None = None,
                config: Path | str = Path("config/web.yaml"),
                transport: httpx.BaseTransport | None = None) -> WebService:
        load_dotenv()
        if replay is None:
            replay = os.environ.get("PRISM_REPLAY") == "1"
        root = Path(cache_dir or os.environ.get("PRISM_CACHE_DIR", ".prism_cache")) / "web"
        cfg = load_web_config(Path(config))
        return cls(cfg, HttpClient(cfg, LLMCache(root, replay=replay), transport))

    @classmethod
    def for_gateway(cls, gateway=None, **kwargs) -> WebService:
        """Share the LLM cache directory and replay switch, so one switch controls both."""
        cache = getattr(gateway, "cache", None)
        if cache is not None:
            kwargs.setdefault("cache_dir", cache.root)
            kwargs.setdefault("replay", cache.replay)
        return cls.default(**kwargs)
