"""Stage 4: constrained report drafting by the generator role."""
from __future__ import annotations

from prism.llm.prompts import render
from prism.schemas import Enquiry, EvidencePack, ReportBody, RequirementsSheet, RuleFindings, stricter


def evidence_lines(pack: EvidencePack) -> list[str]:
    return [f'[{c.id}] ({c.citation()}, {c.scope.value}) {c.claim} — "{c.quote}"' for c in pack.cards]


def build_draft_messages(enquiry: Enquiry, sheet: RequirementsSheet, findings: RuleFindings, pack: EvidencePack,
                         exemplars: dict[str, str], chat_facts=(), preferences=()) -> tuple[list[dict], str]:
    system, h1 = render("draft_system.j2")
    user, h2 = render(
        "draft_user.j2", title=enquiry.title, text=enquiry.text, chat_facts=list(chat_facts),
        preferences=list(preferences), sheet_json=sheet.model_dump_json(indent=1, exclude_defaults=True),
        status=findings.status.value, findings=[f for f in findings.findings if f.severity.value != "info"]
        + [f for f in findings.findings if f.severity.value == "info"],
        candidates=findings.candidates[:12], seeds=findings.question_seeds, evidence=evidence_lines(pack),
        exemplars=exemplars)
    return [{"role": "system", "content": system}, {"role": "user", "content": user}], f"{h1}{h2}"[:12]


def draft(enquiry: Enquiry, sheet: RequirementsSheet, findings: RuleFindings, pack: EvidencePack, gateway,
          exemplars: dict[str, str], chat_facts=(), preferences=(), role: str = "generator") -> tuple[ReportBody, dict]:
    messages, phash = build_draft_messages(enquiry, sheet, findings, pack, exemplars, chat_facts, preferences)
    res = gateway.complete(role, messages, schema=ReportBody)
    body: ReportBody = res.parsed
    body.decision_status = stricter(body.decision_status, findings.status)
    return body, {"model": res.model, "prompt_hash": phash}
