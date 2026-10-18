"""Load LLM profiles: role → adapter, model list and settings (config/llm.yaml)."""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

ROLES = ("extractor", "writer", "writer_deep", "judge", "judge_deep", "patcher", "classifier", "agent", "vision",
         "embedder")
# Legacy role names, resolved to the new ones (and the reverse) when a profile lacks the requested name.
LEGACY_ROLES = {"generator": "writer", "generator_deep": "writer_deep", "critic": "judge", "critic_deep": "judge_deep"}
_ALIASES = {**LEGACY_ROLES, **{new: old for old, new in LEGACY_ROLES.items()}}
_ENV = re.compile(r"\$\{([A-Z0-9_]+)(?::-([^}]*))?\}")


def expand_env(text: str) -> str:
    return _ENV.sub(lambda m: os.environ.get(m.group(1), m.group(2) or ""), text)


@dataclass
class RoleConfig:
    models: list[str]
    reasoning: str = "off"            # off | low | medium | high | model_default
    max_tokens: int = 8000
    temperature: float | None = 0.0   # None = provider default (recommended for Gemini 3+ thinking models)


@dataclass
class Profile:
    name: str
    adapter: str
    base_url: str
    api_key_env: str
    limits: dict[str, int] = field(default_factory=dict)
    capabilities: dict[str, dict] = field(default_factory=dict)
    roles: dict[str, RoleConfig] = field(default_factory=dict)

    def __post_init__(self) -> None:
        # Old and new role names address the same configuration, so old profiles and old callers keep working.
        self.roles = dict(self.roles)
        for name, other in _ALIASES.items():
            if name not in self.roles and other in self.roles:
                self.roles[name] = self.roles[other]

    def role(self, name: str) -> RoleConfig:
        if name in self.roles:
            return self.roles[name]
        alias = _ALIASES.get(name)
        if alias is not None and alias in self.roles:
            return self.roles[alias]
        raise KeyError(f"role {name!r} is not configured in profile {self.name!r}")

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
