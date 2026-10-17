"""Web search settings (config/web.yaml): providers, limits, timeouts and the domain trust policy."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml

TIER_ORDER = ("peer_reviewed", "standards", "vendor", "general")


def host_of(url: str) -> str:
    """Lower-case host without port and a leading 'www.'; '' when the URL has none."""
    from urllib.parse import urlsplit
    try:
        host = (urlsplit(url).hostname or "").lower().rstrip(".")
    except ValueError:
        return ""
    return host.removeprefix("www.")


def _suffix_match(host: str, domains) -> bool:
    return any(host == d or host.endswith("." + d) for d in domains)


@dataclass
class DomainPolicy:
    tiers: dict[str, list[str]] = field(default_factory=dict)
    blocklist: list[str] = field(default_factory=list)
    allow_tiers: tuple[str, ...] = TIER_ORDER

    def is_blocked(self, host: str) -> bool:
        return not host or _suffix_match(host, self.blocklist)

    def tier(self, host: str) -> str:
        for name in TIER_ORDER[:-1]:
            if _suffix_match(host, self.tiers.get(name, [])):
                return name
        return "general"

    def check(self, host: str, tier: str | None = None) -> tuple[bool, str]:
        """(allowed, reason). A tier override (e.g. a preprint record) is checked like a domain tier."""
        if self.is_blocked(host):
            return False, f"{host or 'empty host'} is blocked (content farm, social media or unverifiable site)"
        tier = tier or self.tier(host)
        if tier not in self.allow_tiers:
            return False, f"tier {tier} is not allowed"
        return True, ""


@dataclass
class WebConfig:
    providers: dict[str, dict] = field(default_factory=dict)
    max_queries: int = 3
    results_per_query: int = 6
    max_results: int = 12
    max_fetch: int = 6
    max_external_cards: int = 4
    max_bytes: int = 3_000_000
    max_redirects: int = 3
    excerpt_chars: int = 8000
    quote_min_chars: int = 30
    quote_max_chars: int = 400
    fuzzy_threshold: float = 95.0
    title_threshold: float = 85.0
    connect_s: float = 5.0
    read_s: float = 15.0
    cache_ttl_days: float = 30.0
    user_agent: str = "PRISM-AFS-Assistant/0.1 (research prototype)"
    content_types: tuple[str, ...] = ("text/html", "application/xhtml+xml", "application/pdf", "application/json")
    contact_email_env: str = "PRISM_WEB_MAILTO"
    policy: DomainPolicy = field(default_factory=DomainPolicy)

    @property
    def mailto(self) -> str:
        return os.environ.get(self.contact_email_env, "")

    def provider_enabled(self, name: str) -> bool:
        cfg = self.providers.get(name, {})
        flag = cfg.get("enabled", False)
        if flag == "auto":
            return bool(os.environ.get(cfg.get("env", ""), ""))
        return bool(flag)


def load_web_config(path: Path = Path("config/web.yaml")) -> WebConfig:
    path = Path(path)
    if not path.exists():       # sensible defaults: the three keyless scholarly providers
        return WebConfig(providers={"openalex": {"enabled": True}, "crossref": {"enabled": True},
                                    "europepmc": {"enabled": True}},
                         policy=DomainPolicy(blocklist=["facebook.com", "twitter.com", "x.com", "reddit.com"]))
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    limits, timeouts = raw.get("limits") or {}, raw.get("timeouts") or {}
    policy = DomainPolicy(tiers={k: list(v or []) for k, v in (raw.get("tiers") or {}).items()},
                          blocklist=[d.lower() for d in raw.get("blocklist") or []],
                          allow_tiers=tuple(raw.get("allow_tiers") or TIER_ORDER))
    cfg = WebConfig(providers=dict(raw.get("providers") or {}), policy=policy,
                    user_agent=str(raw.get("user_agent") or WebConfig.user_agent),
                    cache_ttl_days=float(raw.get("cache_ttl_days", 30)),
                    contact_email_env=str(raw.get("contact_email_env") or "PRISM_WEB_MAILTO"))
    if raw.get("content_types"):
        cfg.content_types = tuple(raw["content_types"])
    for key, value in limits.items():
        if hasattr(cfg, key):
            setattr(cfg, key, type(getattr(cfg, key))(value))
    cfg.connect_s, cfg.read_s = float(timeouts.get("connect_s", 5)), float(timeouts.get("read_s", 15))
    return cfg
