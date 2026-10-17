"""Load LLM profiles: role → adapter, model list and settings (config/llm.yaml)."""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

ROLES = ("extractor", "generator", "generator_deep", "critic", "classifier", "agent", "vision", "embedder")
_ENV = re.compile(r"\$\{([A-Z0-9_]+)(?::-([^}]*))?\}")


def expand_env(text: str) -> str:
    return _ENV.sub(lambda m: os.environ.get(m.group(1), m.group(2) or ""), text)


@dataclass
class RoleConfig:
    models: list[str]
    reasoning: str = "off"            # off | low | high | model_default
    max_tokens: int = 8000
    temperature: float | None = 0.0


@dataclass
class Profile:
    name: str
    adapter: str
    base_url: str
    api_key_env: str
    limits: dict[str, int] = field(default_factory=dict)
    capabilities: dict[str, dict] = field(default_factory=dict)
    roles: dict[str, RoleConfig] = field(default_factory=dict)

    def role(self, name: str) -> RoleConfig:
        if name not in self.roles:
            raise KeyError(f"role {name!r} is not configured in profile {self.name!r}")
        return self.roles[name]

    def api_key(self) -> str:
        return os.environ.get(self.api_key_env, "")


def load_profile(path: Path = Path("config/llm.yaml"), name: str | None = None) -> Profile:
    data = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    chosen = name or expand_env(str(data["active_profile"]))
    raw = data["profiles"][chosen]
    roles = {r: RoleConfig(**cfg) for r, cfg in (raw.get("roles") or {}).items()}
    return Profile(name=chosen, adapter=raw["adapter"], base_url=expand_env(str(raw.get("base_url") or "")),
                   api_key_env=raw["api_key_env"], limits=dict(raw.get("limits") or {}),
                   capabilities=dict(raw.get("capabilities") or {}), roles=roles)
