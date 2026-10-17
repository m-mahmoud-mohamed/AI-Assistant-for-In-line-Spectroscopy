"""Provider-agnostic LLM access by role: cache/replay, budget, retries, JSON repair, fallbacks, tools."""
from __future__ import annotations

import json
import os
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path

from dotenv import load_dotenv
from pydantic import BaseModel, ValidationError

from prism.llm.adapters.base import LLMRequest, LLMResponse, ProviderError, RateLimited, ToolCall
from prism.llm.budget import BudgetMeter
from prism.llm.cache import LLMCache
from prism.llm.profiles import Profile, load_profile


class LLMUnavailable(RuntimeError):
    """Every model configured for a role failed."""


@dataclass
class LLMResult:
    text: str
    model: str
    parsed: BaseModel | None = None
    usage: dict = field(default_factory=dict)
    latency_s: float = 0.0
    cached: bool = False
    tool_calls: list[ToolCall] = field(default_factory=list)


@dataclass
class ToolSpec:
    name: str
    description: str
    parameters: dict
    fn: Callable[[dict], dict]

    def openai(self) -> dict:
        return {"type": "function",
                "function": {"name": self.name, "description": self.description, "parameters": self.parameters}}


@dataclass
class ToolRunResult:
    text: str
    model: str
    calls: list[dict]


def extract_json(text: str) -> str:
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise ValueError("no JSON object in model output")
    return text[start:end + 1]


class LLMGateway:
    def __init__(self, profile: Profile, adapter, cache: LLMCache, budget: BudgetMeter | None = None,
                 sleep: Callable[[float], None] = time.sleep, max_wait_s: float = 60.0):
        self.profile, self.adapter, self.cache = profile, adapter, cache
        self.budget = budget or BudgetMeter(profile.limits)
        self.sleep, self.max_wait_s = sleep, max_wait_s
        self.calls: list[dict] = []

    def _call(self, req: LLMRequest) -> tuple[LLMResponse, bool, float]:
        key = self.cache.key({"profile": self.profile.name, **asdict(req)})
        hit = self.cache.get(key)
        if hit is not None:
            return LLMResponse.from_dict(hit), True, 0.0
        for _ in range(3):
            wait = self.budget.wait_seconds()
            if wait:
                self.sleep(min(wait, self.max_wait_s))
            started = time.monotonic()
            try:
                resp = self.adapter.complete(req)
            except RateLimited as e:
                self.sleep(min(e.reset_seconds, self.max_wait_s))
                continue
            self.budget.update_from_headers(resp.headers)
            self.cache.put(key, resp.to_dict())
            return resp, False, time.monotonic() - started
        raise ProviderError("still rate limited after 3 attempts")

    def _log(self, role: str, res: LLMResult) -> LLMResult:
        self.calls.append({"role": role, "model": res.model, "cached": res.cached,
                           "latency_s": round(res.latency_s, 2), "usage": res.usage})
        return res

    def complete(self, role: str, messages: list[dict], schema: type[BaseModel] | None = None,
                 reasoning: str | None = None, max_tokens: int | None = None,
                 tools: list[dict] | None = None) -> LLMResult:
        rc = self.profile.role(role)
        errors: list[str] = []
        for model in rc.models:
            req = LLMRequest(model=model, messages=list(messages),
                             json_schema=schema.model_json_schema() if schema else None,
                             schema_name=schema.__name__ if schema else "output",
                             reasoning=reasoning or rc.reasoning, max_tokens=max_tokens or rc.max_tokens,
                             temperature=rc.temperature, tools=tools)
            try:
                resp, cached, latency = self._call(req)
                if schema is None:
                    return self._log(role, LLMResult(resp.text, resp.model, None, resp.usage, latency, cached,
                                                     resp.tool_calls))
                try:
                    parsed = schema.model_validate_json(extract_json(resp.text))
                    return self._log(role, LLMResult(resp.text, resp.model, parsed, resp.usage, latency, cached))
                except (ValueError, ValidationError) as err:
                    if resp.finish_reason == "length":
                        errors.append(f"{model}: output truncated at max_tokens")
                        continue
                    fix = list(messages) + [
                        {"role": "assistant", "content": resp.text},
                        {"role": "user", "content": f"Your JSON did not validate: {str(err)[:1500]}\n"
                                                    "Return only the corrected JSON object."}]
                    resp2, cached2, latency2 = self._call(replace(req, messages=fix))
                    try:
                        parsed = schema.model_validate_json(extract_json(resp2.text))
                    except (ValueError, ValidationError) as err2:
                        errors.append(f"{model}: invalid JSON after repair ({str(err2)[:200]})")
                        continue
                    return self._log(role, LLMResult(resp2.text, resp2.model, parsed, resp2.usage,
                                                     latency + latency2, cached and cached2))
            except ProviderError as e:
                errors.append(f"{model}: {e}")
        raise LLMUnavailable(f"role {role!r} failed: " + "; ".join(errors))

    def run_tools(self, role: str, messages: list[dict], tools: list[ToolSpec], max_steps: int = 4) -> ToolRunResult:
        specs = {t.name: t for t in tools}
        msgs, calls = list(messages), []
        while True:
            res = self.complete(role, msgs, tools=[t.openai() for t in tools])
            if not res.tool_calls:
                return ToolRunResult(res.text, res.model, calls)
            if len(calls) >= max_steps:
                break
            msgs.append({"role": "assistant", "content": res.text or "",
                         "tool_calls": [{"id": c.id, "type": "function",
                                         "function": {"name": c.name, "arguments": c.arguments}}
                                        for c in res.tool_calls]})
            for c in res.tool_calls:
                try:
                    args = json.loads(c.arguments or "{}")
                    out = specs[c.name].fn(args) if c.name in specs else {"error": f"unknown tool {c.name}"}
                except Exception as e:  # noqa: BLE001 - tool errors go back to the model, never crash the chat
                    out = {"error": str(e)}
                calls.append({"name": c.name, "arguments": c.arguments, "result": out})
                msgs.append({"role": "tool", "tool_call_id": c.id, "content": json.dumps(out, ensure_ascii=False)})
        final = self.complete(role, msgs + [{"role": "user", "content":
                                             "Tool limit reached. Answer now using only the tool results above."}])
        return ToolRunResult(final.text, final.model, calls)

    def embed(self, texts: list[str]) -> list[list[float]] | None:
        rc = self.profile.roles.get("embedder")
        if rc is None:
            return None
        for model in rc.models:
            key = self.cache.key({"profile": self.profile.name, "embed": model, "texts": texts})
            hit = self.cache.get(key)
            if hit is not None:
                return hit["vectors"]
            try:
                vectors = self.adapter.embed(model, texts)
            except (ProviderError, RateLimited):
                continue
            self.cache.put(key, {"vectors": vectors})
            return vectors
        return None


def build_gateway(profile_name: str | None = None, config: Path = Path("config/llm.yaml"),
                  cache_dir: Path | None = None, replay: bool | None = None) -> LLMGateway:
    load_dotenv()
    profile = load_profile(config, profile_name)
    if replay is None:
        replay = os.environ.get("PRISM_REPLAY") == "1"
    cache = LLMCache(Path(cache_dir or os.environ.get("PRISM_CACHE_DIR", ".prism_cache")), replay=replay)
    if profile.adapter == "openai_compatible":
        from prism.llm.adapters.openai_compat import OpenAICompatibleAdapter
        adapter = OpenAICompatibleAdapter(profile.base_url, profile.api_key(), profile.capabilities)
    elif profile.adapter == "anthropic":
        from prism.llm.adapters.anthropic_adapter import AnthropicAdapter
        adapter = AnthropicAdapter(profile.api_key(), profile.capabilities)
    else:
        raise ValueError(f"unknown adapter {profile.adapter!r}")
    return LLMGateway(profile, adapter, cache, BudgetMeter(profile.limits))
