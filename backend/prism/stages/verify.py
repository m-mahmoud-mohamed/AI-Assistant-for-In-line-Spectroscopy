"""Stage 5: deterministic checks plus a critic from a different model family."""
from __future__ import annotations

from prism.kb.loader import KnowledgeBase
from prism.llm.prompts import render
from prism.schemas import (
    ClaimType,
    CriticResult,
    EvidencePack,
    Issue,
    ReportBody,
    RequirementsSheet,
    RuleFindings,
    VerificationReport,
    iter_segments,
)
from prism.stages.checks import CheckContext, run_checks


def critic_claims(body: ReportBody, pack: EvidencePack) -> list[dict]:
    cards = {c.id: c for c in pack.cards}
    return [{"path": path, "text": s.text,
             "quotes": [f"[{cid} | {cards[cid].scope.value}] {cards[cid].quote}" for cid in s.evidence_ids if cid in cards]}
            for path, s in iter_segments(body) if s.claim_type in (ClaimType.AFS, ClaimType.EXTERNAL)]


def verify(body: ReportBody, sheet: RequirementsSheet, findings: RuleFindings, pack: EvidencePack,
           kb: KnowledgeBase, source_texts: list[str], gateway=None, client_question=()) -> VerificationReport:
    issues = run_checks(CheckContext(body, sheet, findings, pack, kb, list(source_texts)))
    verdicts = []
    claims = critic_claims(body, pack)
    if gateway is not None and claims:
        prompt, _ = render("critic.j2", claims=claims, client_question=list(client_question),
                           direct_answer=" ".join(s.text for s in body.direct_answer.text))
        result: CriticResult = gateway.complete("critic", [{"role": "user", "content": prompt}],
                                                schema=CriticResult).parsed
        verdicts = result.verdicts
        for v in verdicts:
            if v.verdict in ("unsupported", "scope_exceeded"):
                issues.append(Issue(check_id="C-SUPPORT", path=v.path, message=f"{v.verdict}: {v.reason}"))
            elif v.verdict == "partial":
                issues.append(Issue(check_id="C-SUPPORT", path=v.path, message=f"partial: {v.reason}",
                                    severity="warning"))
        if not result.direct_answer_responsive:
            issues.append(Issue(check_id="P-DIRECT-ANSWER", path="direct_answer",
                                message="does not answer the client's question"))
        if not result.in_scope:
            issues.append(Issue(check_id="P-SCOPE", path="", message="content outside the spectroscopy assessment"))
    return VerificationReport(issues=issues, verdicts=verdicts)
