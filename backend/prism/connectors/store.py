"""Connector configuration, encrypted credentials and a content-free audit trail."""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import threading
import unicodedata
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit

import yaml
from cryptography.fernet import Fernet

AUTH = {"none", "bearer", "header", "api_key", "oauth"}
PERMISSIONS = {"disabled", "allowed", "ask"}


def now() -> str:
    return datetime.now(UTC).isoformat()


def safe_text(value: str, limit: int = 16000) -> str:
    return "".join(c for c in str(value) if c in "\n\t" or not unicodedata.category(c).startswith("C"))[:limit]


class ConnectorStore:
    def __init__(self, path: Path, key: bytes | None = None):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        if key is None:
            configured = os.environ.get("PRISM_SECRET_KEY")
            key_path = self.path.parent / ".secret_key"
            if configured:
                key = configured.encode()
            else:
                try:
                    fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                except FileExistsError:
                    pass
                else:
                    with os.fdopen(fd, "wb") as file:
                        file.write(Fernet.generate_key())
                os.chmod(key_path, 0o600)
                key = key_path.read_bytes().strip()
        self.cipher = Fernet(key)
        with self.db() as db:
            db.executescript("""
            CREATE TABLE IF NOT EXISTS mcp_servers (
              id TEXT PRIMARY KEY, config TEXT NOT NULL, secrets BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS mcp_audit (
              id INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT, session TEXT, server TEXT, tool TEXT,
              arguments_hash TEXT, summary TEXT, outcome TEXT, duration_ms INTEGER, error TEXT);
            """)

    @contextmanager
    def db(self):
        with self.lock, sqlite3.connect(self.path, timeout=30) as db:
            db.row_factory = sqlite3.Row
            yield db

    def list(self) -> list[dict]:
        with self.db() as db:
            rows = db.execute("SELECT config FROM mcp_servers ORDER BY rowid").fetchall()
        return [json.loads(r[0]) for r in rows]

    def get(self, sid: str) -> dict:
        with self.db() as db:
            row = db.execute("SELECT config FROM mcp_servers WHERE id = ?", (sid,)).fetchone()
        if row is None:
            raise KeyError("Unknown MCP server")
        return json.loads(row[0])

    def secrets(self, sid: str) -> dict:
        with self.db() as db:
            row = db.execute("SELECT secrets FROM mcp_servers WHERE id = ?", (sid,)).fetchone()
        return json.loads(self.cipher.decrypt(row[0])) if row else {}

    def set_secrets(self, sid: str, values: dict) -> None:
        with self.db() as db:
            db.execute("UPDATE mcp_servers SET secrets = ? WHERE id = ?",
                       (self.cipher.encrypt(json.dumps(values).encode()), sid))

    def save(self, config: dict, secrets: dict, sid: str | None = None) -> dict:
        stamp = now()
        old = self.get(sid) if sid else {}
        config = {**config, "id": sid or uuid.uuid4().hex, "created_at": old.get("created_at", stamp),
                  "updated_at": stamp}
        with self.db() as db:
            db.execute("INSERT OR REPLACE INTO mcp_servers VALUES (?, ?, ?)",
                       (config["id"], json.dumps(config), self.cipher.encrypt(json.dumps(secrets).encode())))
        return config

    def delete(self, sid: str) -> None:
        self.get(sid)
        with self.db() as db:
            db.execute("DELETE FROM mcp_servers WHERE id = ?", (sid,))

    def audit(self, session: str, server: str, tool: str, arguments: dict, outcome: str,
              duration_ms: int, error: str | None = None) -> None:
        canonical = json.dumps(arguments, sort_keys=True, ensure_ascii=False)
        # Neither values nor parameter names (which can themselves contain sensitive data) are retained.
        summary = f"{len(arguments)} arguments · values redacted"
        with self.db() as db:
            db.execute("INSERT INTO mcp_audit (time,session,server,tool,arguments_hash,summary,outcome,duration_ms,error) "
                       "VALUES (?,?,?,?,?,?,?,?,?)", (now(), session, server, safe_text(tool, 120),
                       hashlib.sha256(canonical.encode()).hexdigest(), summary, outcome, duration_ms, error))

    def latest_audit(self, limit: int = 100) -> list[dict]:
        with self.db() as db:
            return [dict(r) for r in db.execute("SELECT * FROM mcp_audit ORDER BY id DESC LIMIT ?",
                                               (max(1, min(limit, 500)),))]


def allowlist(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    data = yaml.safe_load(path.read_text()) or {}
    return {entry["id"]: entry for entry in data.get("stdio", [])}


def validate(config: dict, local: dict) -> dict:
    name = str(config.get("name", "")).strip()
    if not name or len(name) > 120 or safe_text(name) != name:
        raise ValueError("Give the server a name of 1–120 printable characters")
    transport = config.get("transport", "http")
    auth = config.get("auth_kind", "none")
    if transport not in {"http", "sse", "stdio"} or auth not in AUTH:
        raise ValueError("Unsupported transport or authentication kind")
    url, stdio_id = config.get("url") or "", config.get("stdio_id") or ""
    if transport == "stdio":
        if stdio_id not in local:
            raise ValueError("Choose an administrator-allowlisted stdio server")
        if auth != "none":
            raise ValueError("Stdio credentials come from the administrator allowlist")
        url = ""
    else:
        parsed = urlsplit(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("Give an HTTP(S) URL without embedded credentials")
        if parsed.query or parsed.fragment or safe_text(url) != url:
            raise ValueError("Put credentials in authentication fields, not URL queries or fragments")
        if len(url) > 2048:
            raise ValueError("Server URL is too long")
        stdio_id = ""
    header = str(config.get("header_name") or "Authorization")
    if not re.fullmatch(r"[A-Za-z0-9-]{1,80}", header) or header.lower() in {
            "host", "content-length", "connection", "cookie", "proxy-authorization"}:
        raise ValueError("Invalid authentication header name")
    permissions = config.get("permissions", {})
    if not isinstance(permissions, dict) or any(v not in PERMISSIONS for v in permissions.values()):
        raise ValueError("Tool permission must be disabled, allowed or ask")
    return {"name": name, "transport": transport, "url": url, "stdio_id": stdio_id, "auth_kind": auth,
            "header_name": header, "enabled": bool(config.get("enabled", True)),
            "may_receive_assessment": bool(config.get("may_receive_assessment", False)),
            "permissions": permissions}
