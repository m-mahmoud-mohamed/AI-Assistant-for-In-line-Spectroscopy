"""Adapter for the Gemini API through the official `google-genai` SDK (native API, not the OpenAI-compatible one).

Mapping (see config/llm.yaml `capabilities` for the per-model switches):
- system messages → `system_instruction`; user/assistant/tool messages → `contents` (consecutive same-role turns merge).
- JSON schema → `response_mime_type="application/json"` + `response_json_schema` (Pydantic schemas are reduced to the
  keywords Gemini accepts). Schemas it cannot express, or that the API rejects as too complex (HTTP 400 about the
  schema), fall back to prompted JSON; the gateway validates and repairs the text as for any other provider.
- tools (OpenAI format) → function declarations. Model function calls come back as `ToolCall`s; the thought signature
  rides in `ToolCall.extra_content` and is restored when the call is sent back (Gemini 3 rejects multi-turn function
  calling without it). Tool results become `function_response` parts.
- `reasoning` → `thinking_config.thinking_level` (off/low → low, medium, high; levels a model does not list in
  `thinking_levels` are mapped to the nearest one it does). `thinking_headroom` adds tokens to `max_output_tokens`
  because thinking tokens count against that limit.
- 429 and 503 → `RateLimited` (the gateway sleeps and retries); everything else → `ProviderError` (next model).
"""
from __future__ import annotations

import base64
import copy
import hashlib
import json
import logging
import math
import re
import threading
import uuid

import httpx
from google import genai
from google.genai import errors, types

from prism.llm.adapters.base import LLMRequest, LLMResponse, ProviderError, RateLimited, ToolCall


class _QuietNonTextWarning(logging.Filter):
    """The SDK warns once per process when a reply has function calls and no text; that is normal for us."""

    def filter(self, record: logging.LogRecord) -> bool:
        return "non-text parts in the response" not in record.getMessage()


logging.getLogger("google_genai.types").addFilter(_QuietNonTextWarning())

SYNTHETIC_ID_PREFIX = "prism-call-"        # ids we invent when the API sends none; never sent back to the API
_LEVELS = ("minimal", "low", "medium", "high")
_DEFAULT_LEVELS = ("low", "medium", "high")
_REASONING_TO_LEVEL = {"off": "low", "low": "low", "medium": "medium", "high": "high"}
_BAD_FINISH = {"SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "LANGUAGE", "OTHER",
               "MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL", "TOO_MANY_TOOL_CALLS", "IMAGE_SAFETY",
               "IMAGE_PROHIBITED_CONTENT", "NO_IMAGE", "IMAGE_RECITATION", "IMAGE_OTHER"}

# ---- JSON Schema → what Gemini's `response_json_schema` / `parameters_json_schema` accept ----------------------------
# Only documented keywords are kept; `title` is dropped as well (Pydantic derives it from the field name, and the schema
# counts as input tokens). Validation of the reply stays with Pydantic in the gateway.

_KEEP = {"$id", "$defs", "$ref", "$anchor", "type", "format", "description", "enum", "items", "prefixItems",
         "minItems", "maxItems", "minimum", "maximum", "anyOf", "oneOf", "properties", "additionalProperties",
         "required"}
_FORMATS = {"date-time", "date", "time", "int32", "int64", "float", "double", "enum"}
_CANNOT_EXPRESS = {"not", "if", "then", "else", "patternProperties", "dependentSchemas", "dependentRequired",
                   "unevaluatedProperties", "unevaluatedItems", "contains", "propertyNames", "$dynamicRef"}


class _Unsupported(Exception):
    pass


def to_gemini_schema(schema: dict) -> dict | None:
    """Reduce a JSON Schema (e.g. `Model.model_json_schema()`) to the keywords Gemini documents, or None when the
    schema uses a feature that cannot be expressed (the caller then falls back to prompted JSON)."""
    try:
        return _convert(copy.deepcopy(schema))
    except _Unsupported:
        return None


def _convert(node):
    if not isinstance(node, dict):
        return node
    if "$ref" in node:                         # next to $ref only $-keywords are allowed
        out = {k: v for k, v in node.items() if k.startswith("$") and k != "$defs"}
        if "$defs" in node:
            out["$defs"] = {name: _convert(d) for name, d in node["$defs"].items()}
        return out
    if "allOf" in node:
        if len(node["allOf"]) != 1:
            raise _Unsupported("allOf")
        rest = {k: v for k, v in node.items() if k != "allOf"}
        return _convert({**node["allOf"][0], **rest})
    if any(k in node for k in _CANNOT_EXPRESS):
        raise _Unsupported("composition keyword")
    if "const" in node:
        value = node["const"]
        node = {k: v for k, v in node.items() if k != "const"}
        node["enum"] = [value]
        node.setdefault("type", {bool: "boolean", int: "integer", float: "number", str: "string"}.get(type(value)))
        if node["type"] is None:
            del node["type"]
    out: dict = {}
    for key, value in node.items():
        if key not in _KEEP:
            continue
        if key in ("properties", "$defs"):
            out[key] = {name: _convert(sub) for name, sub in value.items()}
        elif key in ("anyOf", "oneOf", "prefixItems"):
            out[key] = [_convert(sub) for sub in value]
        elif key == "items":
            out[key] = _convert(value)
        elif key == "additionalProperties":
            out[key] = _convert(value) if isinstance(value, dict) else value
        elif key == "format":
            if value in _FORMATS:
                out[key] = value
        else:
            out[key] = value
    if isinstance(out.get("type"), list):      # draft-07 style ["string", "null"]
        kinds = out.pop("type")
        out["anyOf"] = [{"type": kind} for kind in kinds]
    if out.get("type") == "object" and out.get("properties"):
        out["propertyOrdering"] = list(out["properties"])
    return out


# ---- OpenAI-style messages → Gemini contents --------------------------------------------------------------------------

_DATA_URI = re.compile(r"^data:([^;,]+)(;base64)?,(.*)$", re.DOTALL)


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    return "\n".join(p.get("text", "") for p in content or [] if isinstance(p, dict) and p.get("type") == "text")


def _user_parts(content) -> list[types.Part]:
    if isinstance(content, str):
        return [types.Part(text=content)] if content else []
    parts: list[types.Part] = []
    for item in content or []:
        kind = item.get("type")
        if kind == "text" and item.get("text"):
            parts.append(types.Part(text=item["text"]))
        elif kind == "image_url":
            url = (item.get("image_url") or {}).get("url", "")
            match = _DATA_URI.match(url)
            if match:
                mime, is_b64, payload = match.groups()
                data = base64.b64decode(payload) if is_b64 else payload.encode("utf-8")
                parts.append(types.Part(inline_data=types.Blob(data=data, mime_type=mime)))
            elif url:
                parts.append(types.Part(file_data=types.FileData(file_uri=url)))
    return parts


def _signature(tool_call: dict) -> bytes | None:
    sig = ((tool_call.get("extra_content") or {}).get("google") or {}).get("thought_signature")
    return base64.b64decode(sig) if sig else None


def _api_id(call_id: str | None) -> str | None:
    return None if not call_id or call_id.startswith(SYNTHETIC_ID_PREFIX) else call_id


def _function_response(msg: dict, names: dict[str, str]) -> types.Part:
    raw = msg.get("content")
    text = raw if isinstance(raw, str) else _text_of(raw)
    try:
        body = json.loads(text)
    except ValueError:
        body = text
    response = body if isinstance(body, dict) else {"output": body}
    call_id = msg.get("tool_call_id", "")
    name = msg.get("name") or names.get(call_id, "")
    return types.Part(function_response=types.FunctionResponse(id=_api_id(call_id), name=name, response=response))


def _append(contents: list[types.Content], role: str, parts: list[types.Part]) -> None:
    if not parts:
        return
    if contents and contents[-1].role == role:
        contents[-1].parts = [*(contents[-1].parts or []), *parts]
    else:
        contents.append(types.Content(role=role, parts=parts))


def convert_messages(messages: list[dict]) -> tuple[str, list[types.Content]]:
    system: list[str] = []
    contents: list[types.Content] = []
    names: dict[str, str] = {}                  # tool_call id → function name, for the tool results that follow
    for msg in messages:
        role = msg.get("role")
        if role in ("system", "developer"):
            if text := _text_of(msg.get("content")):
                system.append(text)
        elif role == "tool":
            _append(contents, "user", [_function_response(msg, names)])
        elif role == "assistant":
            parts = [types.Part(text=t)] if (t := _text_of(msg.get("content"))) else []
            for call in msg.get("tool_calls") or []:
                fn = call.get("function") or {}
                names[call.get("id", "")] = fn.get("name", "")
                raw_args = fn.get("arguments") or "{}"
                args = json.loads(raw_args) if isinstance(raw_args, str) else dict(raw_args)
                parts.append(types.Part(function_call=types.FunctionCall(
                    id=_api_id(call.get("id")), name=fn.get("name"), args=args), thought_signature=_signature(call)))
            _append(contents, "model", parts)
        else:
            _append(contents, "user", _user_parts(msg.get("content")))
    return "\n\n".join(system), contents


# ---- errors ---------------------------------------------------------------------------------------------------------


class SchemaRejected(ProviderError):
    """The API refused the response schema (HTTP 400 mentioning the schema); retried once as prompted JSON."""


_SCHEMA_ERROR = re.compile(r"schema|constraint|too many states|nesting", re.IGNORECASE)
_RETRY_IN = re.compile(r"retry in ([0-9.]+)\s*s", re.IGNORECASE)


def _details(err: errors.APIError) -> list[dict]:
    body = err.details if isinstance(err.details, dict) else {}
    found = (body.get("error") or body).get("details") or []
    return [d for d in found if isinstance(d, dict)]


def _retry_delay(err: errors.APIError, default: float) -> float:
    for d in _details(err):
        if str(d.get("@type", "")).endswith("RetryInfo") and d.get("retryDelay"):
            try:
                return float(str(d["retryDelay"]).rstrip("s"))
            except ValueError:
                pass
    if match := _RETRY_IN.search(err.message or ""):
        return float(match.group(1))
    header = getattr(getattr(err, "response", None), "headers", None) or {}
    try:
        return float(header.get("retry-after", default))
    except (TypeError, ValueError):
        return default


def _daily_quota_exhausted(err: errors.APIError) -> bool:
    return any("PerDay" in str(v.get("quotaId", "")) for d in _details(err) for v in d.get("violations") or [])


def convert_error(err: errors.APIError) -> Exception:
    code, status = err.code or 0, err.status or ""
    message = f"{code} {status}: {(err.message or str(err))[:300]}"
    if code == 429 or status == "RESOURCE_EXHAUSTED":
        if _daily_quota_exhausted(err):          # waiting will not help: let the gateway try the next model
            return ProviderError(f"{message} (daily quota exhausted)")
        return RateLimited(min(_retry_delay(err, 10.0), 120.0))
    if code == 503 or status == "UNAVAILABLE":
        return RateLimited(min(_retry_delay(err, 3.0), 120.0))
    if code == 400 and _SCHEMA_ERROR.search(err.message or ""):
        return SchemaRejected(message)
    return ProviderError(message)


# ---- the adapter ------------------------------------------------------------------------------------------------------


class GeminiAdapter:
    def __init__(self, api_key: str, capabilities: dict[str, dict] | None = None, client=None,
                 timeout_s: float = 120.0, embed_batch: int = 100, key_env: str = "GEMINI_API_KEY"):
        self.api_key, self.caps, self.key_env = api_key, capabilities or {}, key_env
        self.timeout_s, self.embed_batch = timeout_s, embed_batch
        self._client = client
        self._lock = threading.Lock()
        self._schema_rejected: set[str] = set()          # schemas the API refused: prompted JSON from now on

    @property
    def client(self):
        if self._client is None:                         # lazy: no key needed to build a gateway (replay mode)
            if not self.api_key:
                raise ProviderError(f"{self.key_env} is not set (add it to .env)")
            with self._lock:
                if self._client is None:
                    self._client = genai.Client(
                        api_key=self.api_key, http_options=types.HttpOptions(timeout=int(self.timeout_s * 1000)))
        return self._client

    # -- request building --

    def _level(self, model: str, reasoning: str) -> str | None:
        cap = self.caps.get(model, {})
        levels = [lv.lower() for lv in cap.get("thinking_levels", _DEFAULT_LEVELS)]
        want = _REASONING_TO_LEVEL.get(reasoning)
        if not levels or want is None:                   # no thinking control, or "model_default"
            return None
        if want not in levels:                           # nearest listed level; on a tie the higher one
            order = _LEVELS.index
            want = min(levels, key=lambda lv: (abs(order(lv) - order(want)), -order(lv)))
        return want

    def _thinking(self, model: str, reasoning: str) -> tuple[types.ThinkingConfig | None, int]:
        cap = self.caps.get(model, {})
        level = self._level(model, reasoning)
        headroom = int((cap.get("thinking_headroom") or {}).get(level or "default", 0))
        if level is None:
            return None, headroom
        if budgets := cap.get("thinking_budgets"):       # models that take a token budget instead of a level
            return types.ThinkingConfig(thinking_budget=int(budgets.get(level, -1)), include_thoughts=False), headroom
        return types.ThinkingConfig(thinking_level=types.ThinkingLevel(level.upper()), include_thoughts=False), headroom

    @staticmethod
    def _declarations(tools: list[dict]) -> list[types.Tool]:
        decls = []
        for tool in tools:
            fn = tool.get("function", tool)
            params = fn.get("parameters") or {}
            kw: dict = {"name": fn["name"], "description": fn.get("description", "")}
            if params.get("properties"):
                kw["parameters_json_schema"] = to_gemini_schema(params) or params
            decls.append(types.FunctionDeclaration(**kw))
        return [types.Tool(function_declarations=decls)]

    def _config(self, req: LLMRequest, system: str, schema: dict | None, prompted: bool) -> types.GenerateContentConfig:
        thinking, headroom = self._thinking(req.model, req.reasoning)
        kw: dict = {"max_output_tokens": req.max_tokens + headroom,
                    "automatic_function_calling": types.AutomaticFunctionCallingConfig(disable=True)}
        if req.temperature is not None:
            kw["temperature"] = req.temperature
        if thinking is not None:
            kw["thinking_config"] = thinking
        if schema is not None or prompted:
            kw["response_mime_type"] = "application/json"
        if schema is not None:
            kw["response_json_schema"] = schema
        elif prompted:
            system = (system + "\n\n" if system else "") + (
                "Respond with a single JSON object that conforms to this JSON Schema. No prose, no code fences.\n"
                + json.dumps(req.json_schema, ensure_ascii=False))
        if system:
            kw["system_instruction"] = system
        if req.tools:
            kw["tools"] = self._declarations(req.tools)
        return types.GenerateContentConfig(**kw)

    # -- calls --

    def complete(self, req: LLMRequest) -> LLMResponse:
        system, contents = convert_messages(req.messages)
        schema, prompted, key = None, False, ""
        if req.json_schema is not None:
            key = hashlib.sha256(json.dumps(req.json_schema, sort_keys=True, default=str).encode()).hexdigest()
            schema = to_gemini_schema(req.json_schema) if self.caps.get(req.model, {}).get("json_schema", True) else None
            prompted = schema is None or key in self._schema_rejected
            schema = None if prompted else schema
        try:
            return self._generate(req, system, contents, schema, prompted)
        except SchemaRejected:
            if schema is None:                           # nothing was sent as a response schema: not our fallback
                raise
            with self._lock:
                self._schema_rejected.add(key)
            return self._generate(req, system, contents, None, True)

    def _generate(self, req: LLMRequest, system: str, contents: list[types.Content], schema: dict | None,
                  prompted: bool) -> LLMResponse:
        config = self._config(req, system, schema, prompted)
        client = self.client
        try:
            raw = client.models.generate_content(model=req.model, contents=contents, config=config)
        except errors.APIError as e:
            raise convert_error(e) from e
        except httpx.HTTPError as e:
            raise ProviderError(f"{type(e).__name__}: {e}"[:300]) from e
        except ValueError as e:                          # reply the SDK could not parse: try the next model
            raise ProviderError(f"unreadable reply from the Gemini API: {e}"[:300]) from e
        return self._parse(raw, req.model)

    @staticmethod
    def _parse(raw, model: str) -> LLMResponse:
        candidates = getattr(raw, "candidates", None) or []
        if not candidates:
            feedback = getattr(raw, "prompt_feedback", None)
            reason = getattr(feedback, "block_reason", None)
            raise ProviderError("no candidates returned" + (f" (prompt blocked: {reason})" if reason else ""))
        cand = candidates[0]
        finish = getattr(cand.finish_reason, "value", cand.finish_reason) if cand.finish_reason else "STOP"
        if str(finish) in _BAD_FINISH:
            raise ProviderError(f"generation stopped: {finish}")
        text, calls = [], []
        for part in (cand.content.parts if cand.content and cand.content.parts else []):
            if part.function_call is not None:
                fc = part.function_call
                extra = None
                if part.thought_signature:
                    extra = {"google": {"thought_signature": base64.b64encode(part.thought_signature).decode("ascii")}}
                calls.append(ToolCall(id=fc.id or f"{SYNTHETIC_ID_PREFIX}{uuid.uuid4().hex[:12]}",
                                      name=fc.name or "", arguments=json.dumps(fc.args or {}, ensure_ascii=False),
                                      extra_content=extra))
            elif part.text and not part.thought:
                text.append(part.text)
        reason = "length" if str(finish) in ("MAX_TOKENS", "CONTINUATION") else ("tool_calls" if calls else "stop")
        headers = {k.lower(): str(v) for k, v in dict(getattr(getattr(raw, "sdk_http_response", None), "headers", None)
                                                      or {}).items() if "ratelimit" in k.lower() or k.lower() == "retry-after"}
        return LLMResponse(text="".join(text), finish_reason=reason, model=model,
                           usage=GeminiAdapter._usage(getattr(raw, "usage_metadata", None)), headers=headers,
                           tool_calls=calls)

    @staticmethod
    def _usage(meta) -> dict:
        if meta is None:
            return {}
        prompt, out = meta.prompt_token_count or 0, meta.candidates_token_count or 0
        thinking, cached = meta.thoughts_token_count or 0, meta.cached_content_token_count or 0
        tool_use = meta.tool_use_prompt_token_count or 0
        return {"prompt_tokens": prompt, "completion_tokens": out, "thinking_tokens": thinking,
                "cached_tokens": cached, "tool_use_prompt_tokens": tool_use,
                "total_tokens": meta.total_token_count or prompt + out + thinking + tool_use}

    def embed(self, model: str, texts: list[str]) -> list[list[float]]:
        dims = self.caps.get(model, {}).get("dimensions")
        config = types.EmbedContentConfig(output_dimensionality=int(dims)) if dims else None
        vectors: list[list[float]] = []
        for start in range(0, len(texts), self.embed_batch):
            batch = texts[start:start + self.embed_batch]
            contents = [types.Content(parts=[types.Part(text=t)]) for t in batch]
            client = self.client
            try:
                raw = client.models.embed_content(model=model, contents=contents, config=config)
            except errors.APIError as e:
                raise convert_error(e) from e
            except httpx.HTTPError as e:
                raise ProviderError(f"{type(e).__name__}: {e}"[:300]) from e
            except ValueError as e:
                raise ProviderError(f"unreadable reply from the Gemini API: {e}"[:300]) from e
            got = [list(e.values or []) for e in (raw.embeddings or [])]
            if len(got) != len(batch) or not all(got):
                raise ProviderError(f"embedding count mismatch: sent {len(batch)}, received {len(got)}")
            vectors += [_unit(v) for v in got] if dims and int(dims) < 3072 else got   # only the full size is normalised
        return vectors


def _unit(vector: list[float]) -> list[float]:
    norm = math.sqrt(sum(x * x for x in vector)) or 1.0
    return [x / norm for x in vector]
