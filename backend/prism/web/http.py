"""HTTP access for web search: polite client, size caps, redirect limit, disk cache with replay semantics.

In replay mode (PRISM_REPLAY=1) this module never touches the network: a cache miss is an empty,
failed response (`error="replay_miss"`), not an exception.
"""
from __future__ import annotations

import base64
import ipaddress
import socket
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import urljoin, urlsplit

import httpx

from prism.llm.cache import LLMCache, ReplayMiss
from prism.web.config import WebConfig

_BLOCKED_NAMES = ("localhost", "localhost.localdomain")
_BLOCKED_SUFFIXES = (".local", ".internal", ".localhost", ".lan", ".home.arpa")


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


@dataclass
class Response:
    ok: bool
    status: int = 0
    url: str = ""                      # final URL after redirects
    content_type: str = ""
    body: bytes = b""
    error: str = ""
    cached: bool = False
    retrieved_at: str = ""

    def json(self):
        import json
        return json.loads(self.body.decode("utf-8", "replace"))


def _public_ip(ip: str) -> bool:
    try:
        return ipaddress.ip_address(ip.split("%")[0]).is_global
    except ValueError:
        return False


def public_host(host: str, resolve: bool = True) -> bool:
    """False for localhost, private / link-local / loopback addresses and internal names (SSRF guard)."""
    host = host.strip("[]").lower()
    if not host or host in _BLOCKED_NAMES or host.endswith(_BLOCKED_SUFFIXES):
        return False
    try:
        ipaddress.ip_address(host)
        return _public_ip(host)
    except ValueError:
        pass
    if not resolve:
        return True
    try:
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except OSError:
        return True                    # not resolvable: the request fails by itself
    return all(_public_ip(info[4][0]) for info in infos)


class HttpClient:
    """GET / POST-JSON with caching. `transport` lets tests inject httpx.MockTransport."""

    def __init__(self, cfg: WebConfig, cache: LLMCache | None = None, transport: httpx.BaseTransport | None = None):
        self.cfg, self.cache, self.transport = cfg, cache, transport
        self.requests = 0              # network requests actually sent (not cache hits)
        self._client: httpx.Client | None = None

    @property
    def replay(self) -> bool:
        return bool(self.cache and self.cache.replay)

    def _http(self) -> httpx.Client:
        if self._client is None:
            timeout = httpx.Timeout(self.cfg.read_s, connect=self.cfg.connect_s)
            self._client = httpx.Client(transport=self.transport, timeout=timeout, follow_redirects=False,
                                        headers={"User-Agent": self._agent()})
        return self._client

    def _agent(self) -> str:
        mail = self.cfg.mailto
        return f"{self.cfg.user_agent} mailto:{mail}" if mail else self.cfg.user_agent

    # ------------------------------------------------------------------ cache

    def _key(self, method: str, url: str, params, body) -> str:
        return LLMCache.key({"web": method, "url": url, "params": sorted((params or {}).items()), "body": body})

    def _from_cache(self, key: str) -> Response | None:
        if self.cache is None:
            return None
        try:
            hit = self.cache.get(key)
        except ReplayMiss:
            return Response(False, error="replay_miss")
        if hit is None:
            return None
        age_days = (time.time() - float(hit.get("cached_at_ts", 0))) / 86400
        if not self.cache.replay and age_days > self.cfg.cache_ttl_days:
            return None
        return Response(ok=bool(hit["ok"]), status=hit["status"], url=hit["url"], content_type=hit["content_type"],
                        body=base64.b64decode(hit["body_b64"]), error=hit.get("error", ""), cached=True,
                        retrieved_at=hit.get("retrieved_at", ""))

    def _to_cache(self, key: str, r: Response) -> None:
        # Answers below 500 are stable (including 404 and size / type refusals); timeouts and 5xx are not cached.
        if self.cache is None or not 0 < r.status < 500:
            return
        try:
            self.cache.put(key, {"ok": r.ok, "status": r.status, "url": r.url, "content_type": r.content_type,
                                 "body_b64": base64.b64encode(r.body).decode(), "error": r.error,
                                 "retrieved_at": r.retrieved_at, "cached_at_ts": time.time()})
        except OSError:
            pass                       # an unwritable cache must not break a run

    # ------------------------------------------------------------------ requests

    def get(self, url: str, params: dict | None = None, headers: dict | None = None, *, page: bool = False,
            max_bytes: int | None = None, types: tuple[str, ...] | None = None) -> Response:
        """`page=True` is for arbitrary URLs: only public hosts, manual redirects re-checked at every hop."""
        return self._request("GET", url, params, headers, None, page, max_bytes, types)

    def post_json(self, url: str, payload: dict, headers: dict | None = None, cache_body: dict | None = None) -> Response:
        return self._request("POST", url, None, headers, payload, False, None, None, cache_body)

    def _request(self, method, url, params, headers, payload, page, max_bytes, types, cache_body=None) -> Response:
        key = self._key(method, url, params, cache_body if cache_body is not None else payload)
        cached = self._from_cache(key)
        if cached is not None:
            return cached
        if self.replay:
            return Response(False, error="replay_miss")
        limit = max_bytes or self.cfg.max_bytes
        types = types or self.cfg.content_types
        resp = self._send(method, url, params, headers, payload, page, limit, types)
        self._to_cache(key, resp)
        return resp

    def _send(self, method, url, params, headers, payload, page, limit, types) -> Response:
        current, hops = url, 0
        while True:
            parts = urlsplit(current)
            if parts.scheme not in ("http", "https") or not parts.hostname:
                return Response(False, url=current, error="unsupported_url")
            if page and (parts.username or not public_host(parts.hostname, resolve=self.transport is None)):
                return Response(False, url=current, error="non_public_host")
            try:
                self.requests += 1
                with self._http().stream(method, current, params=params if hops == 0 else None, headers=headers,
                                         json=payload if method == "POST" else None) as r:
                    if r.status_code in (301, 302, 303, 307, 308) and r.headers.get("location"):
                        hops += 1
                        if hops > self.cfg.max_redirects:
                            return Response(False, r.status_code, current, error="too_many_redirects")
                        current = urljoin(current, r.headers["location"])
                        continue
                    ctype = r.headers.get("content-type", "").split(";")[0].strip().lower()
                    if r.status_code != 200:
                        return Response(False, r.status_code, current, ctype, error=f"http_{r.status_code}",
                                        retrieved_at=now_iso())
                    if ctype and ctype not in types:
                        return Response(False, 200, current, ctype, error="unsupported_content_type",
                                        retrieved_at=now_iso())
                    declared = r.headers.get("content-length", "")
                    if declared.isdigit() and int(declared) > limit:
                        return Response(False, 200, current, ctype, error="too_large", retrieved_at=now_iso())
                    chunks, size = [], 0
                    for chunk in r.iter_bytes():
                        size += len(chunk)
                        if size > limit:
                            return Response(False, 200, current, ctype, error="too_large", retrieved_at=now_iso())
                        chunks.append(chunk)
                    return Response(True, 200, current, ctype, b"".join(chunks), retrieved_at=now_iso())
            except httpx.TimeoutException:
                return Response(False, url=current, error="timeout")
            except httpx.HTTPError as exc:
                return Response(False, url=current, error=f"network_error: {type(exc).__name__}")

    def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None
