"""Adapter for the Anthropic Messages API (used if the project supplies a Claude key)."""
from __future__ import annotations

import anthropic

from prism.llm.adapters.base import LLMRequest, LLMResponse, ProviderError, RateLimited


class AnthropicAdapter:
    def __init__(self, api_key: str, capabilities: dict[str, dict] | None = None, client=None):
        self.client = client or anthropic.Anthropic(api_key=api_key or "missing", max_retries=0)
        self.caps = capabilities or {}

    def complete(self, req: LLMRequest) -> LLMResponse:
        if req.tools:
            raise ProviderError("tool calling is not implemented for the anthropic adapter")
        system = "\n\n".join(m["content"] for m in req.messages if m["role"] == "system")
        messages = [m for m in req.messages if m["role"] != "system"]
        kw: dict = {"model": req.model, "max_tokens": req.max_tokens, "messages": messages}
        if system:
            kw["system"] = system
        output_config: dict = {}
        if req.json_schema is not None:
            output_config["format"] = {"type": "json_schema", "schema": req.json_schema}
        if req.reasoning in ("low", "high"):
            output_config["effort"] = req.reasoning
        elif req.reasoning == "off":
            output_config["effort"] = "low"
        if output_config:
            kw["output_config"] = output_config
        try:
            raw = self.client.messages.with_raw_response.create(**kw)
        except anthropic.RateLimitError as e:
            raise RateLimited(float(e.response.headers.get("retry-after", "10"))) from e
        except (anthropic.APIConnectionError, anthropic.APITimeoutError) as e:
            raise ProviderError(str(e)) from e
        except anthropic.APIStatusError as e:
            raise ProviderError(f"{e.status_code}: {e.message}") from e
        msg = raw.parse()
        if msg.stop_reason == "refusal":
            raise ProviderError("model refused the request")
        text = "".join(b.text for b in msg.content if b.type == "text")
        return LLMResponse(text=text, finish_reason="length" if msg.stop_reason == "max_tokens" else "stop",
                           model=msg.model, usage=msg.usage.model_dump(),
                           headers={k.lower(): v for k, v in raw.headers.items()})

    def embed(self, model: str, texts: list[str]) -> list[list[float]]:
        raise ProviderError("no embeddings endpoint; retrieval falls back to BM25")
