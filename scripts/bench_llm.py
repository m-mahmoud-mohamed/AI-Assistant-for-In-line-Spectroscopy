"""Latency benchmark for an OpenAI-compatible provider: time to first token, decode tokens/s, N-way parallel wall time.

Usage: .venv/bin/python scripts/bench_llm.py --base-url https://chat-ai.academiccloud.de/v1 --key-env SAIA_API_KEY \
           --models qwen3.5-397b-a17b gemma-4-31b-it --parallel 4
       .venv/bin/python scripts/bench_llm.py --profile gemini --parallel 3 --reasoning low
(about len(models) + parallel requests; the key is read from the environment and never printed)

`--profile NAME` takes base URL, key variable and default models (writer, judge, extractor) from config/llm.yaml. For
the gemini profile the benchmark talks to Gemini's OpenAI-compatible endpoint (GEMINI_API_KEY), which supports
streaming and usage; thinking is requested with `--reasoning` (sent as `reasoning_effort`). Thinking time is part of
the time to first token, because thought summaries are not streamed.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import time

import httpx

from prism.llm.profiles import load_profile

GEMINI_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai"
PROMPT = ("You are a spectroscopy application scientist. In about 350 words, explain to a pharmaceutical engineer how "
          "in-line NIR diffuse reflection differs from Raman for monitoring API concentration in a powder blend "
          "(sampling depth, fluorescence, calibration, probe placement). Plain prose, no lists.")


def resolve_target(profile: str, config: str = "config/llm.yaml") -> tuple[str, str, list[str]]:
    """(base URL, key environment variable, default models) for a profile of config/llm.yaml."""
    p = load_profile(config, profile)
    if p.adapter == "gemini":
        base = GEMINI_OPENAI_BASE
    elif p.adapter == "openai_compatible":
        base = p.base_url
    else:
        raise SystemExit(f"profile {profile!r} uses the {p.adapter!r} adapter, which has no OpenAI-compatible endpoint")
    models = list(dict.fromkeys(m for role in ("writer", "judge", "extractor") if role in p.roles
                                for m in p.roles[role].models))
    return base, p.api_key_env, models


async def one(client: httpx.AsyncClient, base: str, key: str, model: str, label: str = "",
              reasoning: str | None = None, max_tokens: int = 600, temperature: float | None = 0.2) -> dict:
    body: dict = {"model": model, "messages": [{"role": "user", "content": PROMPT}], "max_tokens": max_tokens,
                  "stream": True, "stream_options": {"include_usage": True}}
    if temperature is not None:
        body["temperature"] = temperature
    if reasoning:
        body["reasoning_effort"] = reasoning
    if model.startswith("qwen"):
        body["chat_template_kwargs"] = {"enable_thinking": False}
    t0, ttft, chunks, usage = time.perf_counter(), None, 0, None
    async with client.stream("POST", f"{base.rstrip('/')}/chat/completions", json=body,
                             headers={"Authorization": f"Bearer {key}"}) as r:
        limits = {k: v for k, v in r.headers.items() if "ratelimit" in k.lower()}
        async for line in r.aiter_lines():
            if not line.startswith("data: ") or line.endswith("[DONE]"):
                continue
            d = json.loads(line[6:])
            usage = d.get("usage") or usage
            for ch in d.get("choices", []):
                text = ch.get("delta", {}).get("content")
                if text:
                    ttft = ttft or time.perf_counter() - t0
                    chunks += 1
    total = time.perf_counter() - t0
    out = (usage or {}).get("completion_tokens") or chunks
    return {"model": label or model, "status": r.status_code, "ttft_s": round(ttft or -1, 2),
            "total_s": round(total, 2), "out_tokens": out,
            "decode_tok_s": round(out / (total - ttft), 1) if ttft and total > ttft else None, "limits": limits}


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", help="take base URL, key variable and models from this profile of config/llm.yaml")
    ap.add_argument("--base-url")
    ap.add_argument("--key-env")
    ap.add_argument("--models", nargs="+")
    ap.add_argument("--parallel", type=int, default=4, help="parallel calls on the first model (0 to skip)")
    ap.add_argument("--reasoning", choices=["low", "medium", "high"], help="thinking level (reasoning_effort)")
    ap.add_argument("--max-tokens", type=int, help="default 600; 1600 for the gemini profile (thinking counts)")
    ap.add_argument("--temperature", type=float, help="default 0.2; omitted for the gemini profile")
    a = ap.parse_args()
    base, key_env, models = a.base_url, a.key_env, a.models
    gemini = False
    if a.profile:
        p_base, p_key_env, p_models = resolve_target(a.profile)
        base, key_env, models = base or p_base, key_env or p_key_env, models or p_models
        gemini = p_base == GEMINI_OPENAI_BASE
    if not (base and key_env and models):
        ap.error("give --profile, or all of --base-url, --key-env and --models")
    key = os.environ.get(key_env)
    if not key:
        ap.error(f"environment variable {key_env} is not set")
    kw = {"reasoning": a.reasoning, "max_tokens": a.max_tokens or (1600 if gemini else 600),
          "temperature": a.temperature if a.temperature is not None else (None if gemini else 0.2)}
    async with httpx.AsyncClient(timeout=180) as c:
        for m in models:
            print(json.dumps(await one(c, base, key, m, **kw)), flush=True)
        if a.parallel:
            t0 = time.perf_counter()
            runs = await asyncio.gather(*[one(c, base, key, models[0], f"{models[0]}#{i}", **kw)
                                          for i in range(a.parallel)])
            for r in runs:
                print(json.dumps(r), flush=True)
            print(json.dumps({"parallel": a.parallel, "wall_s": round(time.perf_counter() - t0, 2)}))


if __name__ == "__main__":
    asyncio.run(main())
