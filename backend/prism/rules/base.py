"""Rule framework: every rule is a pure function of (requirements sheet, knowledge base) → findings."""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from prism.kb.loader import KnowledgeBase
from prism.schemas import Finding, RequirementsSheet


@dataclass
class RuleContext:
    sheet: RequirementsSheet
    kb: KnowledgeBase

    def methods_intended(self) -> set[str]:
        """Methods the client proposes or already owns (from premises and assets), canonical ids only."""
        found = {p.method for p in self.sheet.premises if p.method}
        found |= {a.method for a in self.sheet.existing_assets if a.method}
        return {m for m in found if m in self.kb.methods}


RuleFn = Callable[[RuleContext], list[Finding]]
REGISTRY: dict[str, RuleFn] = {}


def rule(rule_id: str) -> Callable[[RuleFn], RuleFn]:
    def deco(fn: RuleFn) -> RuleFn:
        if rule_id in REGISTRY:
            raise ValueError(f"duplicate rule {rule_id}")
        REGISTRY[rule_id] = fn
        return fn
    return deco


def run_all(ctx: RuleContext) -> list[Finding]:
    from prism.rules import geometry, physics, premises, process  # noqa: F401  (importing registers the rules)
    return [f for rid in sorted(REGISTRY) for f in REGISTRY[rid](ctx)]
