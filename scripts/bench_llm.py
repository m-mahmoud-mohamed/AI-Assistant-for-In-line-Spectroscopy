"""Latency benchmark for an OpenAI-compatible provider: time to first token, decode tokens/s, N-way parallel wall time.

Usage: .venv/bin/python scripts/bench_llm.py --base-url https://chat-ai.academiccloud.de/v1 --key-env SAIA_API_KEY \
           --models qwen3.5-397b-a17b gemma-4-31b-it --parallel 4
(about len(models) + parallel requests; the key is read from the environment and never printed)
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import time

import httpx

PROMPT = ("You are a spectroscopy application scientist. In about 350 words, explain to a pharmaceutical engineer how "
          "in-line NIR diffuse reflection differs from Raman for monitoring API concentration in a powder blend "
          "(sampling depth, fluorescence, calibration, probe placement). Plain prose, no lists.")


async def one(client: httpx.AsyncClient, base: str, key: str, model: str, label: str = "") -> dict:
    body = {"model": model, "messages": [{"role": "user", "content": PROMPT}], "max_tokens": 600, "temperature": 0.2,
            "stream": True, "stream_options": {"include_usage": True}}
    if model.startswith("qwen"):
        body["chat_template_kwargs"] = {"enable_thinking": False}
    t0, ttft, chunks, usage = time.perf_counter(), None, 0, None
    async with client.stream("POST", f"{base}/chat/completions", json=body,
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
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--key-env", required=True)
    ap.add_argument("--models", nargs="+", required=True)
    ap.add_argument("--parallel", type=int, default=4, help="parallel calls on the first model (0 to skip)")
    a = ap.parse_args()
    key = os.environ[a.key_env]
    async with httpx.AsyncClient(timeout=180) as c:
        for m in a.models:
            print(json.dumps(await one(c, a.base_url, key, m)), flush=True)
        if a.parallel:
            t0 = time.perf_counter()
            runs = await asyncio.gather(*[one(c, a.base_url, key, a.models[0], f"{a.models[0]}#{i}")
                                          for i in range(a.parallel)])
            for r in runs:
                print(json.dumps(r), flush=True)
            print(json.dumps({"parallel": a.parallel, "wall_s": round(time.perf_counter() - t0, 2)}))


if __name__ == "__main__":
    asyncio.run(main())
