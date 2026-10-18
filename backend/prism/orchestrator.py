"""The PRISM batch pipeline: scope → extract → normalise → rules → retrieve → [web] → write → verify → patch → render.

`Pipeline.run` is the batch entry point (CLI, `make answers`, evaluation, API runs). It is the interactive workflow
(`prism.assist.workflow.Workflow`) run straight through: `prepare` then `write`. Questions the engine would ask are
recorded in the report and never waited on.
"""
from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from prism.assist.workflow import (
    EVENT_TYPES,
    PipelineFlags,
    Prepared,
    RunResult,
    Workflow,
    carried_judge_issues,
)
from prism.kb.loader import KnowledgeBase
from prism.schemas import Enquiry

__all__ = ["EVENT_TYPES", "Pipeline", "PipelineFlags", "Prepared", "RunResult", "Workflow", "carried_judge_issues"]


class Pipeline(Workflow):
    def __init__(self, gateway, kb: KnowledgeBase, materials: Path = Path("materials"),
                 flags: PipelineFlags | None = None, emit: Callable[[dict], None] | None = None, web=None):
        super().__init__(gateway, kb, flags, emit, web, materials)

    def run(self, enquiry: Enquiry, chat_facts=(), preferences=()) -> RunResult:
        # Deterministic: same input, KB, profile, chat state and flags give the same run_id.
        prepared = self.prepare(enquiry, chat_facts, preferences=preferences)
        return self.write(prepared, preferences)
