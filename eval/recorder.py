"""A gateway wrapper that records every LLM call of an evaluation run: role, model, usage, latency, the role's
max_tokens, and (for the support judge only) the sentences it was shown with its verdicts. Nothing else of a prompt is
kept, and no key ever passes through here.

`take()` returns the records since the last call, so the runner gets one list per case.
"""
from __future__ import annotations

import re
import threading
import time

from prism.stages.verify import JudgeResult as SupportJudgeResult

_CLAIM_HEAD = re.compile(r"(?m)^- (c\d+): ")
_QUOTE_ID = re.compile(r"\[([^\[\]|]+?) \| [a-z_]+\]")
WRITER_ROLES = ("writer", "writer_deep", "generator", "generator_deep")


def usage_numbers(usage: dict) -> dict[str, int]:
    """Provider usage in one shape: prompt, completion, thinking and cached prompt tokens (OpenAI-style, Anthropic and
    Gemini field names)."""
    usage = usage or {}

    def first(*keys) -> int:
        for k in keys:
            v = usage.get(k)
            if isinstance(v, (int, float)):
                return int(v)
        return 0

    details = usage.get("prompt_tokens_details") or {}
    cached = first("cached_tokens", "cache_read_input_tokens") or int((details or {}).get("cached_tokens") or 0)
    return {"prompt": first("prompt_tokens", "input_tokens"), "completion": first("completion_tokens", "output_tokens"),
            "thinking": first("thinking_tokens"), "cached": cached}


def parse_judge_prompt(prompt: str) -> list[dict]:
    """The claims of a rendered judge prompt (llm/prompts/judge.j2): [{"cid", "text", "ids"}] in prompt order."""
    if "\nClaims:\n" not in prompt:
        return []
    section = prompt.rsplit("\nClaims:\n", 1)[1]
    parts = _CLAIM_HEAD.split(section)
    out = []
    for cid, block in zip(parts[1::2], parts[2::2], strict=False):
        head, _, quotes = block.partition("\n  quotes:")
        text = head.strip()
        if text.startswith('"') and text.endswith('"') and len(text) >= 2:
            text = text[1:-1]
        out.append({"cid": cid, "text": text, "ids": list(dict.fromkeys(_QUOTE_ID.findall(quotes)))})
    return out


class RecordingGateway:
    """Delegates to the wrapped gateway; records each `complete` call (thread-safe: writers run in parallel)."""

    def __init__(self, inner):
        self.inner = inner
        self._records: list[dict] = []
        self._lock = threading.Lock()

    def __getattr__(self, name):                     # budget, cache, profile, calls, usage_summary, requests, ...
        return getattr(self.inner, name)

    def _cap(self, role: str) -> int | None:
        profile = getattr(self.inner, "profile", None)
        try:
            return int(profile.role(role).max_tokens) if profile is not None else None
        except (KeyError, AttributeError, TypeError, ValueError):
            return None

    def complete(self, role, messages, schema=None, reasoning=None, max_tokens=None, tools=None):
        started = time.monotonic()
        record: dict = {"role": role, "schema": getattr(schema, "__name__", None),
                        "max_tokens": max_tokens or self._cap(role)}
        try:
            res = self.inner.complete(role, messages, schema=schema, reasoning=reasoning, max_tokens=max_tokens,
                                      tools=tools)
        except Exception as exc:
            record |= {"error": type(exc).__name__, "wall_s": round(time.monotonic() - started, 3)}
            self._add(record)
            raise
        record |= {"model": getattr(res, "model", ""), "cached": bool(getattr(res, "cached", False)),
                   "latency_s": round(float(getattr(res, "latency_s", 0.0) or 0.0), 3),
                   "wall_s": round(time.monotonic() - started, 3), "usage": dict(getattr(res, "usage", {}) or {}),
                   "finish_reason": getattr(res, "finish_reason", None)}
        if schema is SupportJudgeResult and getattr(res, "parsed", None) is not None:
            prompt = messages[-1]["content"] if messages else ""
            record["claims"] = parse_judge_prompt(prompt if isinstance(prompt, str) else "")
            record["verdicts"] = [v.model_dump() for v in res.parsed.verdicts]
        self._add(record)
        return res

    def run_tools(self, role, messages, tools, max_steps=4):
        return self.inner.run_tools(role, messages, tools, max_steps=max_steps)

    def embed(self, texts):
        return self.inner.embed(texts)

    def _add(self, record: dict) -> None:
        with self._lock:
            self._records.append(record)

    def take(self) -> list[dict]:
        with self._lock:
            out, self._records = self._records, []
        return out


def judged_sentences(calls: list[dict], verdicts: list, cards: dict) -> list[dict]:
    """The sentences the support judge saw in one run, with its verdicts, the report path and the cited quotes.
    `verdicts` are the run's ClaimVerdicts (they carry the paths, in the judge's answer order); `cards` maps ids to
    cards (the knowledge base plus the run's web cards)."""
    out = []
    paths = [getattr(v, "path", None) or (v.get("path") if isinstance(v, dict) else None) for v in verdicts]
    for call in calls:
        if "claims" not in call:
            continue
        claims = {c["cid"]: c for c in call["claims"]}
        answered = [v for v in call.get("verdicts", []) if v.get("id") in claims]
        aligned = len(answered) == len(paths)
        for k, v in enumerate(answered):
            claim = claims[v["id"]]
            quotes = []
            for cid in claim["ids"]:
                card = cards.get(cid)
                if card is not None:
                    quotes.append({"id": cid, "citation": card.citation(), "scope": card.scope.value,
                                   "quote": card.quote})
            ext = any(q["citation"].startswith("[EXT]") for q in quotes)
            out.append({"cid": v["id"], "path": paths[k] if aligned else "", "text": claim["text"],
                        "claim_type": "EXTERNAL" if ext else "AFS", "ids": claim["ids"], "quotes": quotes,
                        "verdict": "unsupported" if v.get("verdict") == "scope_exceeded" else v.get("verdict"),
                        "reason": v.get("reason", "")})
    return out
