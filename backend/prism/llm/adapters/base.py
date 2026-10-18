"""Provider-neutral request/response types and errors shared by all adapters."""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from typing import Protocol

import httpx

# A connect that hangs (SYN dropped) fails fast and is sent again; only the read may take the full timeout.
CONNECT_TIMEOUT_S = 10.0
CONNECT_RETRIES = 2


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: str
    # Provider-opaque data that must travel with the call when it is sent back, e.g. Gemini's thought signature
    # ({"google": {"thought_signature": "<base64>"}}), the same shape Gemini's OpenAI-compatible API uses.
    extra_content: dict | None = None

    def to_message(self) -> dict:
        """This call as an OpenAI-style `tool_calls` entry of an assistant message (keeps `extra_content`)."""
        msg: dict = {"id": self.id, "type": "function", "function": {"name": self.name, "arguments": self.arguments}}
        if self.extra_content:
            msg["extra_content"] = self.extra_content
        return msg


@dataclass
class LLMRequest:
    model: str
    messages: list[dict]
    json_schema: dict | None = None
    schema_name: str = "output"
    reasoning: str = "off"            # off | low | medium | high | model_default
    max_tokens: int = 8000
    temperature: float | None = 0.0
    tools: list[dict] | None = None


@dataclass
class LLMResponse:
    text: str
    finish_reason: str
    model: str
    usage: dict = field(default_factory=dict)
    headers: dict = field(default_factory=dict)
    tool_calls: list[ToolCall] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> LLMResponse:
        calls = [ToolCall(**c) for c in d.get("tool_calls", [])]
        return cls(text=d["text"], finish_reason=d["finish_reason"], model=d["model"], usage=d.get("usage", {}),
                   headers=d.get("headers", {}), tool_calls=calls)


class RateLimited(Exception):
    def __init__(self, reset_seconds: float):
        super().__init__(f"rate limited; reset in {reset_seconds}s")
        self.reset_seconds = reset_seconds


class ProviderError(Exception):
    """Non-retryable on this model (server error, timeout, refusal, bad request): try the next model."""


class QuotaExhausted(ProviderError):
    """The model's daily (or plan) quota is used up: try the next model, and skip this one for a while."""


def connect_failed(err: BaseException) -> bool:
    """The request never reached the server (DNS, refused, or a connect that timed out), so sending it again is safe."""
    return isinstance(err.__cause__, (httpx.ConnectError, httpx.ConnectTimeout))


def retry_connect[T](send: Callable[[], T]) -> T:
    """`send()`, sent again up to CONNECT_RETRIES times when the connection could not be made."""
    for _ in range(CONNECT_RETRIES):
        try:
            return send()
        except Exception as e:
            if not connect_failed(e):
                raise
    return send()


class Adapter(Protocol):
    def complete(self, req: LLMRequest) -> LLMResponse: ...
    def embed(self, model: str, texts: list[str]) -> list[list[float]]: ...
