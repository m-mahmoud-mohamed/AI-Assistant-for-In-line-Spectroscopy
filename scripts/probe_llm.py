"""Probe the active LLM profile (bypasses the cache on purpose).

Usage: PRISM_LLM_PROFILE=openai .venv/bin/python scripts/probe_llm.py   (≈ 2 requests per model + 1 per embedder)
       make probe PROFILE=gemini                                       (deep probe: ≈ 5 requests per model)

The deep probe (default for the gemini adapter, or --deep) also checks what Gemini-class providers get wrong most
often: a full tool-calling round trip (the tool call goes back with its thought signature, then the tool result) and
whether the thinking levels declared in config/llm.yaml are accepted (and how many thinking tokens they cost).
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from prism.llm.adapters.base import LLMRequest
from prism.llm.gateway import build_gateway

_SCHEMA = {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"]}
_TOOL = [{"type": "function", "function": {
    "name": "convert_units", "description": "Convert a spectral value",
    "parameters": {"type": "object", "properties": {"value": {"type": "number"}}, "required": ["value"]}}}]
_USER_TOOL = {"role": "user", "content": "Convert 4000 cm-1 using the tool."}


def _is_json(text: str) -> bool:
    try:
        return json.loads(text[text.find("{"): text.rfind("}") + 1]).get("ok") is True
    except (ValueError, AttributeError):
        return False


def _tool_roundtrip(gw, model: str, first) -> bool:
    """Send the model's own tool call back (extra_content included) with a tool result; expect a text answer."""
    call = first.tool_calls[0]
    messages = [_USER_TOOL,
                {"role": "assistant", "content": first.text or "", "tool_calls": [call.to_message()]},
                {"role": "tool", "tool_call_id": call.id, "content": json.dumps({"value": 2.5, "unit": "um"})}]
    second = gw.adapter.complete(LLMRequest(model=model, messages=messages, tools=_TOOL, reasoning="off",
                                            max_tokens=600))
    gw.budget.update_from_headers(second.headers)
    return bool(second.text.strip()) and not second.tool_calls


def _thinking(gw, model: str) -> dict:
    levels = [lv.lower() for lv in gw.profile.capabilities.get(model, {}).get("thinking_levels", [])]
    out: dict = {}
    for level in dict.fromkeys(levels[:1] + levels[-1:]):          # lowest and highest declared level
        r = gw.adapter.complete(LLMRequest(model=model, messages=[{"role": "user", "content":
                                "Is 1013 prime? Answer with one word."}], reasoning=level, max_tokens=300))
        gw.budget.update_from_headers(r.headers)
        out[level] = {"accepted": True, "thinking_tokens": r.usage.get("thinking_tokens"),
                      "finish_reason": r.finish_reason}
    return out


def probe(gw, deep: bool | None = None) -> dict:
    deep = gw.profile.adapter == "gemini" if deep is None else deep
    report: dict = {"profile": gw.profile.name, "models": {}, "embeddings": {}}
    models = sorted({m for role, rc in gw.profile.roles.items() if role != "embedder" for m in rc.models})
    for model in models:
        caps: dict = {}
        try:
            r = gw.adapter.complete(LLMRequest(model=model, messages=[{"role": "user", "content":
                                    'Return the JSON object {"ok": true}.'}], json_schema=_SCHEMA,
                                    reasoning="off", max_tokens=2000))
            gw.budget.update_from_headers(r.headers)
            caps["json_schema"] = _is_json(r.text)
            t = gw.adapter.complete(LLMRequest(model=model, messages=[_USER_TOOL], tools=_TOOL, reasoning="off",
                                    max_tokens=600))
            gw.budget.update_from_headers(t.headers)
            caps["tools"] = bool(t.tool_calls)
            if deep and t.tool_calls:
                caps["tool_roundtrip"] = _tool_roundtrip(gw, model, t)
            if deep and gw.profile.capabilities.get(model, {}).get("thinking_levels"):
                caps["thinking"] = _thinking(gw, model)
        except Exception as e:  # noqa: BLE001 - report, never crash the probe
            caps["error"] = str(e)[:200]
        report["models"][model] = caps
    for model in (gw.profile.roles.get("embedder").models if "embedder" in gw.profile.roles else []):
        try:
            report["embeddings"][model] = len(gw.adapter.embed(model, ["probe"])[0])
        except Exception as e:  # noqa: BLE001 - report, never crash the probe
            report["embeddings"][model] = f"error: {str(e)[:120]}"
    report["limits"] = gw.budget.snapshot()
    return report


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--profile", help="profile in config/llm.yaml (default: PRISM_LLM_PROFILE)")
    ap.add_argument("--deep", action="store_true", help="also test the tool round trip and thinking levels")
    a = ap.parse_args()
    gw = build_gateway(a.profile)
    report = probe(gw, deep=True if a.deep else None)
    out = Path(f"config/probe.{gw.profile.name}.json")
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
