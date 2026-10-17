"""SQLite persistence for sessions, chat messages, runs, reports and replayable run events."""
from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, case_id TEXT, created_at TEXT NOT NULL,
  chat_facts_json TEXT NOT NULL DEFAULT '[]', preferences_json TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), role TEXT NOT NULL, kind TEXT NOT NULL,
  text TEXT NOT NULL, run_id TEXT, created_at TEXT NOT NULL, ord INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), version INTEGER NOT NULL,
  status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, manifest_json TEXT, decision_status TEXT,
  error TEXT);
CREATE TABLE IF NOT EXISTS reports (
  run_id TEXT PRIMARY KEY REFERENCES runs(id), report_json TEXT NOT NULL, report_md TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS web_cards (
  run_id TEXT NOT NULL REFERENCES runs(id), card_id TEXT NOT NULL, card_json TEXT NOT NULL,
  PRIMARY KEY (run_id, card_id));
CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL REFERENCES runs(id), seq INTEGER NOT NULL, event_json TEXT NOT NULL,
  PRIMARY KEY (run_id, seq));
"""

RUN_STATUSES = ("running", "done", "refused", "failed")


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def new_id() -> str:
    return uuid.uuid4().hex[:12]


class Store:
    """Thread-safe: one short-lived connection per operation, writes serialised by a lock."""

    def __init__(self, db_path: Path = Path("data/prism.db")):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        with self._db() as db:
            db.executescript(SCHEMA)

    @contextmanager
    def _db(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            conn = sqlite3.connect(self.db_path, timeout=30)
            conn.row_factory = sqlite3.Row
            try:
                with conn:
                    yield conn
            finally:
                conn.close()

    # ------------------------------------------------------------------ sessions and messages

    def create_session(self, title: str, case_id: str | None = None, text: str = "") -> str:
        sid = new_id()
        with self._db() as db:
            db.execute("INSERT INTO sessions (id, title, case_id, created_at) VALUES (?, ?, ?, ?)",
                       (sid, title, case_id, _now()))
        if text:
            self.add_message(sid, "user", "enquiry", text)
        return sid

    @staticmethod
    def _session(row: sqlite3.Row) -> dict:
        return {"id": row["id"], "title": row["title"], "case_id": row["case_id"], "created_at": row["created_at"]}

    def list_sessions(self) -> list[dict]:
        with self._db() as db:
            rows = db.execute("SELECT * FROM sessions ORDER BY created_at DESC, rowid DESC").fetchall()
        return [self._session(r) for r in rows]

    def get_session(self, session_id: str) -> dict | None:
        with self._db() as db:
            row = db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
            if row is None:
                return None
            msgs = db.execute("SELECT * FROM messages WHERE session_id = ? ORDER BY ord", (session_id,)).fetchall()
            runs = db.execute("SELECT * FROM runs WHERE session_id = ? AND status IN ('done', 'refused') "
                              "ORDER BY version", (session_id,)).fetchall()
        messages = [{k: m[k] for k in ("id", "session_id", "role", "kind", "text", "run_id", "created_at")}
                    for m in msgs]
        reports = [{"version": r["version"], "run_id": r["id"], "created_at": r["finished_at"] or r["started_at"],
                    "decision_status": r["decision_status"]} for r in runs if r["status"] == "done"]
        return self._session(row) | {"messages": messages, "reports": reports}

    def add_message(self, session_id: str, role: str, kind: str, text: str, run_id: str | None = None) -> str:
        mid = new_id()
        with self._db() as db:
            ord_ = db.execute("SELECT COALESCE(MAX(ord), -1) + 1 FROM messages WHERE session_id = ?",
                              (session_id,)).fetchone()[0]
            db.execute("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                       (mid, session_id, role, kind, text, run_id, _now(), ord_))
        return mid

    def enquiry_text(self, session_id: str) -> str | None:
        with self._db() as db:
            row = db.execute("SELECT text FROM messages WHERE session_id = ? AND kind = 'enquiry' ORDER BY ord "
                             "LIMIT 1", (session_id,)).fetchone()
        return row["text"] if row else None

    def chat_state(self, session_id: str) -> tuple[list[str], list[str]]:
        """Chat facts and preferences passed to Pipeline.run for re-runs."""
        with self._db() as db:
            row = db.execute("SELECT chat_facts_json, preferences_json FROM sessions WHERE id = ?",
                             (session_id,)).fetchone()
        return (json.loads(row[0]), json.loads(row[1])) if row else ([], [])

    def set_chat_state(self, session_id: str, chat_facts: list[str], preferences: list[str]) -> None:
        with self._db() as db:
            db.execute("UPDATE sessions SET chat_facts_json = ?, preferences_json = ? WHERE id = ?",
                       (json.dumps(list(chat_facts)), json.dumps(list(preferences)), session_id))

    # ------------------------------------------------------------------ runs, reports and events

    def create_run(self, session_id: str, run_id: str | None = None) -> tuple[str, int]:
        run_id = run_id or new_id()
        with self._db() as db:
            version = db.execute("SELECT COALESCE(MAX(version), 0) + 1 FROM runs WHERE session_id = ?",
                                 (session_id,)).fetchone()[0]
            db.execute("INSERT INTO runs (id, session_id, version, status, started_at) VALUES (?, ?, ?, ?, ?)",
                       (run_id, session_id, version, "running", _now()))
        return run_id, version

    def finish_run(self, run_id: str, result_json: dict) -> None:
        """Store the full run result ({report, markdown, findings, scope, manifest}); report None = refused."""
        report = result_json.get("report")
        status = "done" if report is not None else "refused"
        with self._db() as db:
            db.execute("INSERT OR REPLACE INTO reports VALUES (?, ?, ?)",
                       (run_id, json.dumps(result_json, ensure_ascii=False), result_json.get("markdown", "")))
            db.execute("UPDATE runs SET status = ?, finished_at = ?, manifest_json = ?, decision_status = ? "
                       "WHERE id = ?",
                       (status, _now(), json.dumps(result_json.get("manifest")),
                        report.get("decision_status") if report else None, run_id))

    def add_web_cards(self, run_id: str, cards: list[dict]) -> None:
        """Verified web cards of a run, so the UI can open them by id (they are not in the KB)."""
        with self._db() as db:
            for card in cards:
                db.execute("INSERT OR REPLACE INTO web_cards VALUES (?, ?, ?)",
                           (run_id, card["id"], json.dumps(card, ensure_ascii=False)))

    def web_card(self, card_id: str, run_id: str | None = None) -> dict | None:
        """One web card; without a run id the most recent run that holds it."""
        sql, args = "SELECT card_json FROM web_cards WHERE card_id = ?", [card_id]
        if run_id:
            sql, args = sql + " AND run_id = ?", [card_id, run_id]
        with self._db() as db:
            row = db.execute(sql + " ORDER BY rowid DESC LIMIT 1", args).fetchone()
        return json.loads(row[0]) if row else None

    def fail_run(self, run_id: str, error: str) -> None:
        with self._db() as db:
            db.execute("UPDATE runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?",
                       (_now(), error, run_id))

    def run(self, run_id: str) -> dict | None:
        with self._db() as db:
            row = db.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        return dict(row) if row else None

    def add_event(self, run_id: str, event: dict) -> dict:
        """Append an event; the store assigns `seq` (0, 1, …) per run and returns the stored event."""
        with self._db() as db:
            seq = db.execute("SELECT COALESCE(MAX(seq), -1) + 1 FROM events WHERE run_id = ?",
                             (run_id,)).fetchone()[0]
            event = {**event, "run_id": run_id, "seq": seq}
            db.execute("INSERT INTO events VALUES (?, ?, ?)", (run_id, seq, json.dumps(event, ensure_ascii=False,
                                                                                       default=str)))
        return event

    def events(self, run_id: str, after_seq: int = -1) -> list[dict]:
        with self._db() as db:
            rows = db.execute("SELECT event_json FROM events WHERE run_id = ? AND seq > ? ORDER BY seq",
                              (run_id, after_seq)).fetchall()
        return [json.loads(r[0]) for r in rows]

    def report(self, run_id: str) -> dict | None:
        with self._db() as db:
            row = db.execute("SELECT report_json FROM reports WHERE run_id = ?", (run_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def latest_report(self, session_id: str) -> dict | None:
        with self._db() as db:
            row = db.execute("SELECT r.report_json FROM reports r JOIN runs u ON u.id = r.run_id "
                             "WHERE u.session_id = ? AND u.status = 'done' ORDER BY u.version DESC LIMIT 1",
                             (session_id,)).fetchone()
        return json.loads(row[0]) if row else None
