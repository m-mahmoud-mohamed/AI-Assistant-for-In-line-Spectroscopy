"""Test double for LLMGateway: scripted responses per role, no network."""
from __future__ import annotations

from prism.llm.gateway import LLMResult, ToolRunResult


class FakeGateway:
    def __init__(self, scripted: dict[str, list] | None = None, vectors: dict[str, list[float]] | None = None):
        self.scripted = {k: list(v) for k, v in (scripted or {}).items()}
        self.vectors = vectors
        self.requests: list[dict] = []
        self.calls: list[dict] = []

    def complete(self, role, messages, schema=None, reasoning=None, max_tokens=None, tools=None):
        self.requests.append({"role": role, "messages": messages, "schema": schema, "reasoning": reasoning})
        item = self.scripted[role].pop(0)
        if isinstance(item, Exception):
            raise item
        if schema is not None:
            parsed = item if isinstance(item, schema) else schema.model_validate(item)
            return LLMResult(text=parsed.model_dump_json(), model=f"fake-{role}", parsed=parsed)
        return LLMResult(text=item, model=f"fake-{role}")

    def run_tools(self, role, messages, tools, max_steps=4):
        self.requests.append({"role": role, "messages": messages, "tools": [t.name for t in tools]})
        item = self.scripted[role].pop(0)
        return item(tools) if callable(item) else ToolRunResult(text=item, model=f"fake-{role}", calls=[])

    def embed(self, texts):
        if self.vectors is None:
            return None
        return [self.vectors.get(t, [0.0, 1.0]) for t in texts]
