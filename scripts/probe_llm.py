"""Probe the active LLM profile (bypasses the cache on purpose).

Usage: PRISM_LLM_PROFILE=gwdg .venv/bin/python scripts/probe_llm.py   (≈ 2 requests per model + 1 per embedder)
"""
from __future__ import annotations

import json
from pathlib import Path

from prism.llm.adapters.base import LLMRequest
from prism.llm.gateway import build_gateway

_SCHEMA = {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"]}
_TOOL = [{"type": "function", "function": {
    "name": "convert_units", "description": "Convert a spectral value",
    "parameters": {"type": "object", "properties": {"value": {"type": "number"}}, "required": ["value"]}}}]


def _is_json(text: str) -> bool:
    try:
        return json.loads(text[text.find("{"): text.rfind("}") + 1]).get("ok") is True
    except (ValueError, AttributeError):
        return False


def probe(gw) -> dict:
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
            t = gw.adapter.complete(LLMRequest(model=model, messages=[{"role": "user", "content":
                                    "Convert 4000 cm-1 using the tool."}], tools=_TOOL, reasoning="off",
                                    max_tokens=600))
            gw.budget.update_from_headers(t.headers)
            caps["tools"] = bool(t.tool_calls)
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
    gw = build_gateway()
    report = probe(gw)
    out = Path(f"config/probe.{gw.profile.name}.json")
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
