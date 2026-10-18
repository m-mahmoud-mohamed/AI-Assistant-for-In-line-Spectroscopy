"""Adapter for OpenAI-compatible chat APIs (GWDG SAIA, OpenAI, Azure OpenAI, vLLM, Ollama, …)."""
from __future__ import annotations

import httpx
import openai

from prism.llm.adapters.base import (
    CONNECT_TIMEOUT_S,
    LLMRequest,
    LLMResponse,
    ProviderError,
    RateLimited,
    ToolCall,
    Transcription,
    retry_connect,
)


class OpenAICompatibleAdapter:
    def __init__(self, base_url: str, api_key: str, capabilities: dict[str, dict] | None = None,
                 client=None, timeout: float = 300.0):
        self.client = client or openai.OpenAI(base_url=base_url or None, api_key=api_key or "missing",
                                              timeout=httpx.Timeout(timeout, connect=CONNECT_TIMEOUT_S),
                                              max_retries=0)
        self.caps = capabilities or {}

    def _kwargs(self, req: LLMRequest) -> dict:
        # Capabilities per model (config/llm.yaml): `max_tokens_param` (OpenAI reasoning models take
        # max_completion_tokens), `reasoning_off` (the effort that means "no thinking", e.g. none or minimal) and
        # `reasoning_headroom` (tokens added per effort, because reasoning tokens count against the limit).
        cap = self.caps.get(req.model, {})
        effort = (cap.get("reasoning_off") if req.reasoning == "off" else
                  req.reasoning if req.reasoning in ("low", "medium", "high") else None)
        headroom = (cap.get("reasoning_headroom") or {}).get(effort or "default", 0) if cap.get("reasoning_effort") else 0
        kw: dict = {"model": req.model, "messages": req.messages,
                    cap.get("max_tokens_param", "max_tokens"): req.max_tokens + int(headroom)}
        if req.temperature is not None:
            kw["temperature"] = req.temperature
        if req.json_schema is not None and cap.get("json_schema", True):
            kw["response_format"] = {"type": "json_schema",
                                     "json_schema": {"name": req.schema_name, "schema": req.json_schema}}
        if req.tools:
            kw["tools"] = req.tools
        if cap.get("thinking_toggle") and req.reasoning in ("off", "low", "medium", "high"):
            kw["extra_body"] = {"chat_template_kwargs": {"enable_thinking": req.reasoning != "off"}}
        if cap.get("reasoning_effort") and effort:
            kw["reasoning_effort"] = effort
        return kw

    def complete(self, req: LLMRequest) -> LLMResponse:
        try:
            kw = self._kwargs(req)
            raw = retry_connect(lambda: self.client.chat.completions.with_raw_response.create(**kw))
        except openai.RateLimitError as e:
            reset = 10.0
            if e.response is not None:
                reset = float(e.response.headers.get("ratelimit-reset", reset))
            raise RateLimited(reset) from e
        except (openai.APIConnectionError, openai.APITimeoutError) as e:
            raise ProviderError(str(e)) from e
        except openai.APIStatusError as e:
            raise ProviderError(f"{e.status_code}: {e.message}") from e
        comp = raw.parse()
        choice = comp.choices[0]
        msg = choice.message
        # extra_content (e.g. Gemini's thought signature on its OpenAI-compatible endpoint) must be sent back unchanged
        calls = [ToolCall(id=c.id, name=c.function.name, arguments=c.function.arguments or "{}",
                          extra_content=x if isinstance(x := getattr(c, "extra_content", None), dict) else None)
                 for c in (msg.tool_calls or [])]
        return LLMResponse(text=msg.content or "", finish_reason=choice.finish_reason or "",
                           model=comp.model or req.model, usage=comp.usage.model_dump() if comp.usage else {},
                           headers={k.lower(): v for k, v in raw.headers.items()}, tool_calls=calls)

    def embed(self, model: str, texts: list[str]) -> list[list[float]]:
        try:
            res = self.client.embeddings.create(model=model, input=texts)
        except openai.RateLimitError as e:
            raise RateLimited(10.0) from e
        except openai.APIError as e:
            raise ProviderError(str(e)) from e
        return [d.embedding for d in res.data]

    def transcribe(self, model: str, audio: bytes, mime: str, language: str) -> Transcription:
        extensions = {"audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "mp4",
                      "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav"}
        kwargs = {"model": model, "file": (f"recording.{extensions.get(mime, 'webm')}", audio, mime)}
        if language != "auto":
            kwargs["language"] = language
        try:
            response = self.client.audio.transcriptions.create(**kwargs)
        except openai.RateLimitError as e:
            raise RateLimited(10.0) from e
        except openai.APIError as e:
            raise ProviderError("Audio transcription failed") from e
        text = (response.text or "").strip()
        detected = "ar" if any("\u0600" <= c <= "\u06ff" for c in text) else "en"
        return Transcription(text, detected if language == "auto" else language)
