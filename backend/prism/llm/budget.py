"""Track the provider's request budget: rate-limit response headers when the provider sends them, otherwise the
configured `limits` counted locally. Thread-safe: the gateway is called from several threads at once."""
from __future__ import annotations

import threading
import time
from collections import deque
from collections.abc import Callable, Mapping

WINDOWS = ("minute", "hour", "day", "month")
WINDOW_SECONDS = {"minute": 60.0, "hour": 3600.0, "day": 86400.0, "month": 30 * 86400.0}


class BudgetMeter:
    def __init__(self, limits: Mapping[str, int] | None = None, clock: Callable[[], float] = time.monotonic):
        self.limits: dict[str, int] = dict(limits or {})
        self.remaining: dict[str, int | None] = {w: None for w in WINDOWS}   # as reported by response headers
        self.reset_s = 0.0
        self._clock = clock
        self._lock = threading.RLock()
        self._stamps: dict[str, deque[float]] = {w: deque() for w in WINDOWS}   # local call counting
        self._blocked_until = 0.0
        self.total_calls = 0

    def update_from_headers(self, headers: Mapping[str, str]) -> None:
        h = {k.lower(): v for k, v in headers.items()}
        with self._lock:
            for w in WINDOWS:
                if f"x-ratelimit-remaining-{w}" in h:
                    self.remaining[w] = int(float(h[f"x-ratelimit-remaining-{w}"]))
                if f"x-ratelimit-limit-{w}" in h:
                    self.limits[w] = int(float(h[f"x-ratelimit-limit-{w}"]))
            if "ratelimit-reset" in h:
                self.reset_s = float(h["ratelimit-reset"])

    def _local_count(self, window: str) -> int:
        stamps, horizon = self._stamps[window], self._clock() - WINDOW_SECONDS[window]
        while stamps and stamps[0] <= horizon:
            stamps.popleft()
        return len(stamps)

    def _remaining(self, window: str) -> int | None:
        """Headers win when the provider sends them; otherwise the configured limit minus the local count."""
        if self.remaining[window] is not None:
            return self.remaining[window]
        if window in self.limits:
            return max(0, self.limits[window] - self._local_count(window))
        return None

    def _local_minute_wait(self) -> float:
        limit = self.limits.get("minute")
        if limit is None or self.remaining["minute"] is not None or self._local_count("minute") < limit:
            return 0.0
        return max(0.0, self._stamps["minute"][0] + WINDOW_SECONDS["minute"] - self._clock())

    def wait_seconds(self) -> float:
        with self._lock:
            header_wait = self.reset_s if self.remaining["minute"] == 0 else 0.0
            return max(header_wait, self._local_minute_wait())

    def reserve(self) -> float:
        """Take one request slot. Returns 0 when the call may go ahead now (it is counted), else seconds to wait.
        Only the per-minute window blocks; hour/day/month are advisory (see can_afford)."""
        with self._lock:
            now = self._clock()
            if self.remaining["minute"] == 0 and self.reset_s > 0 and self._blocked_until <= 0:
                self._blocked_until = now + self.reset_s
            if self._blocked_until > 0:
                if now < self._blocked_until:
                    return self._blocked_until - now
                self._blocked_until, self.remaining["minute"] = 0.0, None      # waited it out; trust the next reply
            wait = self._local_minute_wait()
            if wait > 0:
                return wait
            for w in WINDOWS:
                self._stamps[w].append(now)
            self.total_calls += 1
            return 0.0

    def can_afford(self, calls: int) -> bool:
        with self._lock:
            return all(r is None or r >= calls for w in WINDOWS if w != "minute"
                       for r in [self._remaining(w)])

    def snapshot(self) -> dict:
        with self._lock:
            return {"limits": dict(self.limits), "remaining": {w: self._remaining(w) for w in WINDOWS},
                    "local_calls": {w: self._local_count(w) for w in WINDOWS}, "total_calls": self.total_calls}
