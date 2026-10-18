"""Test double for LLMGateway: scripted responses per role, no network."""
from __future__ import annotations

import threading

from prism.assist.sections import (
    AnswerSection,
    ConceptSection,
    PlanSection,
    RecProse,
    build_skeleton,
    with_application_candidates,
)
from prism.llm.gateway import LLMResult, ToolRunResult

OK_JUDGE = {"verdicts": []}


class FakeGateway:
    """Scripted responses. `scripted[role]` is consumed in call order; `by_schema[schema]` answers calls that ask for
    that schema whatever the role (the three parallel section writers share one role and arrive in any order)."""

    def __init__(self, scripted: dict[str, list] | None = None, vectors: dict[str, list[float]] | None = None,
                 by_schema: dict[type, list] | None = None):
        self.scripted = {k: list(v) for k, v in (scripted or {}).items()}
        self.by_schema = {k: list(v) for k, v in (by_schema or {}).items()}
        self.vectors = vectors
        self.requests: list[dict] = []
        self.calls: list[dict] = []
        self._lock = threading.Lock()

    def complete(self, role, messages, schema=None, reasoning=None, max_tokens=None, tools=None):
        self.requests.append({"role": role, "messages": messages, "schema": schema, "reasoning": reasoning})
        with self._lock:
            queue = self.by_schema.get(schema) if schema is not None and schema in self.by_schema else None
            item = (queue if queue is not None else self.scripted[role]).pop(0)
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

    def transcribe(self, audio, mime, language="auto"):
        from prism.llm.adapters.base import Transcription
        self.requests.append({"role": "transcriber", "audio": audio, "mime": mime, "language": language})
        item = self.scripted["transcriber"].pop(0)
        if isinstance(item, Exception):
            raise item
        return Transcription(**item)

    def embed(self, texts):
        if self.vectors is None:
            return None
        return [self.vectors.get(t, [0.0, 1.0]) for t in texts]


def workflow_fake(sheet=None, n: int = 1, sections: dict[type, object] | None = None, judge=None,
                  extractor: list | None = None, **scripted) -> FakeGateway:
    """A gateway for `n` complete runs: extraction returns `sheet`, the three writers return `sections` (default:
    empty drafts, so every sentence comes from code), the judge approves everything. Extra roles via `scripted`."""
    from tests.factories import make_sheet
    sheet = sheet or make_sheet(matrix="liquid", targets=("water content",))
    drafts = {AnswerSection: AnswerSection(), ConceptSection: ConceptSection(), PlanSection: PlanSection()}
    drafts.update(sections or {})
    roles = {"extractor": extractor if extractor is not None else [sheet.model_dump(mode="json")] * n,
             "judge": [judge or OK_JUDGE] * n, "judge_deep": [judge or OK_JUDGE] * n}
    roles.update(scripted)
    return FakeGateway(roles, by_schema={
        schema: [draft if isinstance(draft, Exception) else draft.model_copy(deep=True) for _ in range(n)]
        for schema, draft in drafts.items()})


def judged_answer(kb, sheet) -> AnswerSection:
    """An answer draft whose first rationale sentence paraphrases a card claim, so the support judge has work
    (sentences that copy a card's claim word for word are supported by construction and are not judged)."""
    from prism.rules.engine import evaluate
    from prism.schemas import ClaimType, Segment
    findings = with_application_candidates(evaluate(sheet, kb), sheet, kb)
    rec = build_skeleton(sheet, findings, kb).recs[0]
    claim = rec.fallback[0]
    text = claim.text.rstrip(".") + ", as the source states."
    return AnswerSection(recommendations=[RecProse(rec_id=rec.id, rationale=[
        Segment(text=text, claim_type=ClaimType.AFS, evidence_ids=list(claim.evidence_ids))])])
