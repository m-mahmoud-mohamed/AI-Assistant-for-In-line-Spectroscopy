"""Stage 0b: keep PRISM to its purpose; answer everything else with concrete suggestions."""
from __future__ import annotations

import math
import re

from prism.kb.loader import KnowledgeBase
from prism.llm.prompts import render
from prism.schemas import ScopeDecision, ScopeLabel

PURPOSE = ("PRISM gives a first technical assessment of in-line spectroscopy for a process or material "
           "measurement.")
EXAMPLES = ("Monitor fat and protein in an opaque dairy product in-line.",
            "Follow API concentration in a tablet press feed frame.",
            "Track moisture in polymer pellets on a conveyor with a fiber probe.")
WHAT_TO_TELL = ("Tell me what you need to measure, the sample or process medium, where in the process, the "
                "equipment you already have, your reference method and the decision you need to make.")
_OFF_TOPIC_EXEMPLARS = ("Write a poem about autumn.", "What is the weather tomorrow?",
                        "Fix the bug in my Python code.", "Recommend a good restaurant in Berlin.")


def suggestions() -> list[str]:
    return [WHAT_TO_TELL, *(f"Example: {e}" for e in EXAMPLES)]


def _hits(text: str, terms) -> int:
    t = text.lower()
    return sum(1 for term in terms if re.search(rf"(?<![\w-]){re.escape(str(term).lower())}(?![\w-])", t))


def signal_scores(text: str, lexicon: dict) -> tuple[int, int, int]:
    sig = lexicon.get("scope_signals", {})
    domain = [s for group in ("methods", "techniques", "fibers") for names in lexicon.get(group, {}).values()
              for s in names]
    return (_hits(text, sig.get("in_scope", [])) + _hits(text, domain), _hits(text, sig.get("off_topic", [])),
            _hits(text, sig.get("unsafe", [])))


def _cos(a: list[float], b: list[float]) -> float:
    na, nb = math.sqrt(sum(x * x for x in a)), math.sqrt(sum(x * x for x in b))
    return 0.0 if not na or not nb else sum(x * y for x, y in zip(a, b)) / (na * nb)


def guard(text: str, kb: KnowledgeBase, gateway=None, in_examples=()) -> ScopeDecision:
    ins, off, unsafe = signal_scores(text, kb.lexicon)
    if unsafe:
        return ScopeDecision(label=ScopeLabel.UNSAFE, suggestions=suggestions(),
                             reason="The message asks PRISM to bypass its rules or reveal internal configuration.")
    if ins >= 2 and off == 0:
        return ScopeDecision(label=ScopeLabel.IN_SCOPE, reason="Process measurement request (keyword signals).")
    if ins == 0 and off >= 1:
        return ScopeDecision(label=ScopeLabel.OFF_TOPIC, suggestions=suggestions(),
                             reason="The message is not about a process or material measurement.")
    if gateway is not None and in_examples:
        vectors = gateway.embed([text, *in_examples, *_OFF_TOPIC_EXEMPLARS])
        if vectors:
            n = len(in_examples)
            sim_in = max(_cos(vectors[0], v) for v in vectors[1:1 + n])
            sim_off = max(_cos(vectors[0], v) for v in vectors[1 + n:])
            if sim_in - sim_off >= 0.15:
                return ScopeDecision(label=ScopeLabel.IN_SCOPE, tier="embeddings",
                                     reason="Similar to known process measurement enquiries.")
            if sim_off - sim_in >= 0.15:
                return ScopeDecision(label=ScopeLabel.OFF_TOPIC, tier="embeddings", suggestions=suggestions(),
                                     reason="The message is not about a process or material measurement.")
    if gateway is not None:
        prompt, _ = render("scope.j2", text=text, purpose=PURPOSE)
        decision = gateway.complete("classifier", [{"role": "user", "content": prompt}], schema=ScopeDecision,
                                    reasoning="off").parsed
        decision.tier = "classifier"
        if decision.label != ScopeLabel.IN_SCOPE and not decision.suggestions:
            decision.suggestions = suggestions()
        return decision
    if ins:
        return ScopeDecision(label=ScopeLabel.IN_SCOPE, reason="Keyword signals only (no model available).")
    return ScopeDecision(label=ScopeLabel.OFF_TOPIC, suggestions=suggestions(),
                         reason="Keyword signals only (no model available).")


def refusal_text(decision: ScopeDecision) -> str:
    return "\n".join([PURPOSE, decision.reason, "", *[f"- {s}" for s in decision.suggestions]])
