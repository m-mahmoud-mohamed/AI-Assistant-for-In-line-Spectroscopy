"""Assistant turns (CONTRACTS C4): one scientist message, worked on by a background thread.

    Turn    the event emitter of one turn (`{type, turn_id, seq, ts, payload}`, stored in SQLite so an SSE client can
            resume with Last-Event-ID), its stop flag, and the question or approval it pauses on
    Turns   the live turns of this process: start one on a thread, find one by id, end it cleanly

A turn ends with exactly one terminal event: `turn_completed` or `turn_failed`. Stop ends it at once (the plan as it
stood, then `turn_completed` with `stopped: true`); the worker notices the flag between steps and emits nothing more.
"""
from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable

from prism.store import Store

log = logging.getLogger(__name__)

TERMINAL = ("turn_completed", "turn_failed")
WAIT_LIMIT_S = 3600.0                # a question or approval left open this long ends the turn
STOPPED_MESSAGE = "Stopped. Ask again or pick up where it left off."


class Stopped(Exception):
    """The scientist pressed Stop (or a newer turn of the session replaced this one)."""


class Turn:
    def __init__(self, store: Store, turn_id: str, session_id: str):
        self.store, self.id, self.session_id = store, turn_id, session_id
        self._cv = threading.Condition()
        self._stop = threading.Event()
        self._waiting: tuple[str, str] | None = None      # ("question" | "approval", id)
        self._reply: object = None
        self._replied = False
        self.finished = False
        self.plan: list[dict] = []                         # the last plan shown, so Stop can close it
        self.done = threading.Event()
        self.result: dict | None = None                    # what `/messages` returns (legacy turns)
        self.error: BaseException | None = None
        self.question_rounds = 0
        self.asked: set[str] = set()

    # ------------------------------------------------------------ events

    def emit(self, type_: str, **payload) -> dict | None:
        """Store and publish one event; nothing is emitted after the terminal one."""
        with self._cv:
            if self.finished:
                return None
            if type_ == "plan":
                self.plan = [dict(s) for s in payload.get("steps", [])]
            if type_ in TERMINAL:
                self.finished = True
            event = self.store.add_turn_event(self.id, {"type": type_, "turn_id": self.id, "ts": time.time(),
                                                         "payload": payload})
            if type_ == "turn_completed":
                self.store.set_turn_status(self.id, "stopped" if payload.get("stopped") else "completed")
            elif type_ == "turn_failed":
                self.store.set_turn_status(self.id, "failed", error=str(payload.get("error", "")))
            return event

    def complete(self, message: str, citations: dict[str, str] | None = None, **extra) -> None:
        self.emit("turn_completed", message=message, citations=dict(citations or {}), **extra)

    def fail(self, error: str) -> None:
        self.emit("turn_failed", error=error)

    # ------------------------------------------------------------ stop

    @property
    def stopped(self) -> bool:
        return self._stop.is_set()

    def check(self) -> None:
        """Between steps: end here if the scientist pressed Stop."""
        if self._stop.is_set():
            raise Stopped()

    def stop(self) -> None:
        """Set the flag, wake a pause, and end the turn now: the plan's open steps fall back to pending, as in the UI.
        Atomic with respect to `wait_for`, so a card is either shown before the stop or not at all."""
        self._stop.set()
        with self._cv:
            self._cv.notify_all()
            if self.finished:
                return
            if self.plan:
                self.emit("plan", steps=[{**s, "status": "pending"} if s.get("status") == "active" else s
                                         for s in self.plan])
            self.complete(STOPPED_MESSAGE, stopped=True)

    # ------------------------------------------------------------ pauses

    def wait_for(self, kind: str, ident: str, payload: dict) -> object:
        """Show a question or approval card (`kind` is the event type) and wait for the scientist's reply."""
        with self._cv:
            if self.finished or self._stop.is_set():
                raise Stopped()
            self._waiting, self._reply, self._replied = (kind, ident), None, False
            self.store.set_turn_status(self.id, "waiting", pending={"type": kind, **payload})
            self.emit(kind, **payload)
        deadline = time.monotonic() + WAIT_LIMIT_S
        with self._cv:
            while not self._replied and not self._stop.is_set():
                left = deadline - time.monotonic()
                if left <= 0:
                    break
                self._cv.wait(timeout=min(left, 1.0))
            replied, reply, self._waiting = self._replied, self._reply, None
        if not replied:
            if not self._stop.is_set():
                self.stop()                                # nobody answered: end the turn like a Stop
            raise Stopped()
        with self._cv:
            if not self.finished:
                self.store.set_turn_status(self.id, "running")
        return reply

    def reply(self, kind: str, ident: str, value: object) -> bool:
        """Deliver the scientist's answer or decision; False when the turn does not wait for exactly this card."""
        with self._cv:
            if self.finished or self._waiting != (kind, ident) or self._replied:
                return False
            self._reply, self._replied = value, True
            self._cv.notify_all()
            return True

    @property
    def waiting(self) -> tuple[str, str] | None:
        with self._cv:
            return self._waiting


class Turns:
    """The turns this process is working on."""

    def __init__(self, store: Store):
        self.store = store
        self._live: dict[str, Turn] = {}
        self._lock = threading.Lock()

    def get(self, turn_id: str) -> Turn | None:
        with self._lock:
            return self._live.get(turn_id)

    def start(self, session_id: str, kind: str, input_: dict, work: Callable[[Turn], None]) -> Turn:
        """Run `work(turn)` on a thread. A newer turn replaces one of the same session that is still open."""
        with self._lock:
            older = [t for t in self._live.values() if t.session_id == session_id]
            for t in older:
                t.stop()
            turn = Turn(self.store, self.store.create_turn(session_id, kind, input_), session_id)
            self._live[turn.id] = turn
        threading.Thread(target=self._run, args=(turn, work), daemon=True, name=f"turn-{turn.id}").start()
        return turn

    def _run(self, turn: Turn, work: Callable[[Turn], None]) -> None:
        try:
            work(turn)
            if not turn.finished:                          # a worker that forgot to end its turn
                turn.complete("")
        except Stopped:
            pass
        except Exception as exc:  # noqa: BLE001 - any failure ends the turn with turn_failed
            log.warning("turn %s failed: %s: %s", turn.id, type(exc).__name__, exc)
            turn.error = exc
            turn.fail(f"{type(exc).__name__}: {exc}")
        finally:
            turn.done.set()
            with self._lock:
                self._live.pop(turn.id, None)
