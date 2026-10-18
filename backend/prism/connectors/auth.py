"""SDK OAuth authorization-code/PKCE flow with encrypted, persistent token storage."""
from __future__ import annotations

import asyncio
from urllib.parse import parse_qs, urlsplit

from mcp.client.auth import OAuthClientProvider
from mcp.shared.auth import (
    AuthorizationCodeResult,
    OAuthClientInformationFull,
    OAuthClientMetadata,
    OAuthToken,
)
from mcp.shared.auth_utils import calculate_token_expiry

from prism.connectors.store import ConnectorStore


class AuthorizationRequired(Exception):
    """Raised when a background connection needs the scientist to sign in again (never carries remote text)."""


class TokenStore:
    def __init__(self, store: ConnectorStore, sid: str):
        self.store, self.sid = store, sid

    async def get_tokens(self):
        value = self.store.secrets(self.sid).get("oauth_tokens")
        return OAuthToken.model_validate(value) if value else None

    async def set_tokens(self, tokens):
        # The SDK keeps the expiry only in memory; persisting it makes a restart refresh an expired token.
        self.store.set_secrets(self.sid, {**self.store.secrets(self.sid), "oauth_tokens": tokens.model_dump(mode="json"),
                                        "oauth_expiry": calculate_token_expiry(tokens.expires_in)})

    async def get_expiry(self) -> float | None:
        return self.store.secrets(self.sid).get("oauth_expiry")

    async def get_client_info(self):
        value = self.store.secrets(self.sid).get("oauth_client")
        return OAuthClientInformationFull.model_validate(value) if value else None

    async def set_client_info(self, client_info):
        self.store.set_secrets(self.sid, {**self.store.secrets(self.sid),
                                        "oauth_client": client_info.model_dump(mode="json")})


class Provider(OAuthClientProvider):
    async def _initialize(self) -> None:  # SDK 2.3.0 hook: restore the persisted expiry along with the tokens
        await super()._initialize()
        self.context.token_expiry_time = await self.context.storage.get_expiry()


class OAuthFlow:
    def __init__(self, store: ConnectorStore, config: dict, callback_url: str, interactive: bool):
        self.url: str | None = None
        self.state: str | None = None
        self.callback = asyncio.get_running_loop().create_future()
        self.interactive = interactive
        self.provider = Provider(
            server_url=config["url"], storage=TokenStore(store, config["id"]),
            client_metadata=OAuthClientMetadata(client_name="PRISM", redirect_uris=[callback_url],
                grant_types=["authorization_code", "refresh_token"], response_types=["code"],
                token_endpoint_auth_method="none"),
            redirect_handler=self.redirect, callback_handler=self.receive)

    async def redirect(self, url: str):
        if not self.interactive:
            raise AuthorizationRequired("OAuth authorization required")
        self.state = parse_qs(urlsplit(url).query).get("state", [None])[0]
        self.url = url

    async def receive(self):
        return await asyncio.wait_for(self.callback, 180)

    def complete(self, code: str, state: str, issuer: str | None = None):
        if not self.state or state != self.state or self.callback.done():
            raise ValueError("Invalid or expired OAuth state")
        self.callback.set_result(AuthorizationCodeResult(code=code, state=state, iss=issuer))
        self.state = None
