"""Cost per report = tokens × the price the user enters in config/prices.yaml (no price is ever guessed here).

Prices are per million tokens and per model. A model without an input and an output price makes the cost unknown
(None), so a half-filled table never shows a misleadingly low number.
"""
from __future__ import annotations

from pathlib import Path

import yaml

PRICES = Path(__file__).resolve().parents[1] / "config" / "prices.yaml"
PER = 1_000_000


def load_prices(path: Path = PRICES) -> dict:
    """{"currency": str, "models": {model: {"input", "output", "cached_input"}}}; empty when the file is missing."""
    path = Path(path)
    if not path.exists():
        return {"currency": "", "models": {}}
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return {"currency": str(raw.get("currency") or ""), "models": dict(raw.get("models") or {})}


def _price(prices: dict, model: str) -> dict | None:
    models = prices.get("models", {})
    for key in (model, model.removeprefix("models/"), model.rsplit("/", 1)[-1]):
        if key in models and isinstance(models[key], dict):
            return models[key]
    return None


def cost(tokens_by_model: dict[str, dict], prices: dict) -> float | None:
    """Cost of the given tokens ({model: {"in", "out", "cached"}}); None if any model with tokens has no price, or
    if no tokens were recorded at all (a provider that reports no usage costs "unknown", not 0). Cached prompt
    tokens use `cached_input` when it is set, else the input price."""
    if not any(t.get("in") or t.get("out") for t in tokens_by_model.values()):
        return None
    total = 0.0
    for model, t in tokens_by_model.items():
        if not (t.get("in") or t.get("out")):
            continue
        p = _price(prices, model)
        if p is None or p.get("input") is None or p.get("output") is None:
            return None
        cached = float(t.get("cached") or 0) if p.get("cached_input") is not None else 0.0
        total += ((float(t.get("in") or 0) - cached) * float(p["input"]) + cached * float(p.get("cached_input") or 0)
                  + float(t.get("out") or 0) * float(p["output"])) / PER
    return total
