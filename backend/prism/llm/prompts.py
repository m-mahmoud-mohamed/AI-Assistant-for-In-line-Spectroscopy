"""Versioned Jinja2 prompt templates. render() returns (text, template_hash)."""
from __future__ import annotations

import hashlib
from importlib import resources

from jinja2 import Environment, PackageLoader, StrictUndefined

_env = Environment(loader=PackageLoader("prism", "llm/prompts"), undefined=StrictUndefined,
                   trim_blocks=True, lstrip_blocks=True, keep_trailing_newline=True)


def _template_hash(name: str) -> str:
    folder = resources.files("prism") / "llm" / "prompts"
    parts = [(folder / name).read_text(encoding="utf-8")]
    parts += [f.read_text(encoding="utf-8") for f in sorted(folder.iterdir(), key=lambda p: p.name)
              if f.name.startswith("_") and f.name.endswith(".j2")]
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()[:12]


def render(name: str, **ctx) -> tuple[str, str]:
    return _env.get_template(name).render(**ctx), _template_hash(name)
