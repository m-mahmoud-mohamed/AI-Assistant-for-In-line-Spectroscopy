"""Persistent URL imports use PRISM's bounded HTTP layer, with DNS checks even in injected transports."""
from __future__ import annotations

import ipaddress
import re
import socket
from urllib.parse import urlsplit, urlunsplit

import httpx

from prism.web.config import WebConfig
from prism.web.http import HttpClient, public_host

_NUMERIC_HOST = re.compile(r"[0-9a-fx.]+", re.IGNORECASE)


def canonical_url(url: str) -> str:
    try:
        p = urlsplit(url.strip())
        if p.scheme.lower() not in ("http", "https") or not p.hostname or p.username or p.password:
            raise ValueError("Only public HTTP/HTTPS URLs without credentials are supported")
        host = p.hostname.lower().rstrip(".")
        port = p.port
        host = f"[{host}]" if ":" in host else host
        netloc = host + (f":{port}" if port and port != {"http": 80, "https": 443}[p.scheme.lower()] else "")
        return urlunsplit((p.scheme.lower(), netloc, p.path or "/", p.query, ""))
    except (ValueError, KeyError) as exc:
        raise ValueError("Invalid URL; use a public HTTP/HTTPS URL without credentials") from exc


def validate_public_url(url: str, resolver=None) -> str:
    url = canonical_url(url)
    host = urlsplit(url).hostname
    if not public_host(host, resolve=False):
        raise ValueError("Private, loopback and local hosts are not allowed")
    try:
        try:
            addresses = [str(ipaddress.ip_address(host))]
        except ValueError:
            if _NUMERIC_HOST.fullmatch(host):  # 2130706433, 0x7f.1, 017700000001: legacy spellings of an IP
                raise ValueError("Numeric host spellings are not allowed; use a DNS name or a dotted address") from None
            addresses = [info[4][0] for info in (resolver or socket.getaddrinfo)(host, None, type=socket.SOCK_STREAM)]
        if not addresses or any(not ipaddress.ip_address(a.split("%")[0]).is_global for a in addresses):
            raise ValueError("URL resolves to a non-public address")
    except OSError as exc:
        raise ValueError("URL host could not be resolved") from exc
    return url


class SourceHttp(HttpClient):
    def __init__(self, transport=None, resolver=None):
        super().__init__(WebConfig(content_types=("text/html", "application/xhtml+xml", "application/pdf",
                                                  "text/plain", "text/markdown")), transport=transport)
        self.resolver = resolver

    def _http(self):
        client = super()._http()
        if not client.event_hooks["request"]:
            def check(request):
                try:
                    validate_public_url(str(request.url), self.resolver)
                except ValueError as exc:
                    raise httpx.RequestError(str(exc), request=request) from exc
            client.event_hooks["request"].append(check)
        return client
