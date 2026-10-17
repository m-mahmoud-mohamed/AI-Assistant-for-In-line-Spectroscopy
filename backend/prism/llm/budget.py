"""Track the provider's request budget from rate-limit response headers."""
from __future__ import annotations

from collections.abc import Mapping

WINDOWS = ("minute", "hour", "day", "month")


class BudgetMeter:
    def __init__(self, limits: Mapping[str, int] | None = None):
        self.limits: dict[str, int] = dict(limits or {})
        self.remaining: dict[str, int | None] = {w: None for w in WINDOWS}
        self.reset_s = 0.0

    def update_from_headers(self, headers: Mapping[str, str]) -> None:
        h = {k.lower(): v for k, v in headers.items()}
        for w in WINDOWS:
            if f"x-ratelimit-remaining-{w}" in h:
                self.remaining[w] = int(float(h[f"x-ratelimit-remaining-{w}"]))
            if f"x-ratelimit-limit-{w}" in h:
                self.limits[w] = int(float(h[f"x-ratelimit-limit-{w}"]))
        if "ratelimit-reset" in h:
            self.reset_s = float(h["ratelimit-reset"])

    def wait_seconds(self) -> float:
        return self.reset_s if self.remaining["minute"] == 0 else 0.0

    def can_afford(self, calls: int) -> bool:
        return all(r is None or r >= calls for w, r in self.remaining.items() if w != "minute")

    def snapshot(self) -> dict:
        return {"limits": dict(self.limits), "remaining": dict(self.remaining)}
