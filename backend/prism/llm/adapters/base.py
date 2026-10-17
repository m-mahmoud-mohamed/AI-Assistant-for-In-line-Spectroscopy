"""Provider-neutral request/response types and errors shared by all adapters."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Protocol


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: str


@dataclass
class LLMRequest:
    model: str
    messages: list[dict]
    json_schema: dict | None = None
    schema_name: str = "output"
    reasoning: str = "off"
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


class Adapter(Protocol):
    def complete(self, req: LLMRequest) -> LLMResponse: ...
    def embed(self, model: str, texts: list[str]) -> list[list[float]]: ...
