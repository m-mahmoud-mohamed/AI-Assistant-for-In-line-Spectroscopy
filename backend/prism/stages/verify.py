"""Stage 5: layered verification. Deterministic checks and the unit-aware number guard, the claim-type gate, and one
batched support-judge call for the sentences that rest on sources (AFS, EXTERNAL)."""
from __future__ import annotations

import logging
import re
from typing import Literal

import yaml
from pydantic import BaseModel, Field
from rapidfuzz import fuzz

from prism.kb.loader import KnowledgeBase
from prism.llm.prompts import render
from prism.schemas import (
    Card,
    ClaimType,
    ClaimVerdict,
    EvidencePack,
    Issue,
    ReportBody,
    RequirementsSheet,
    RuleFindings,
    Segment,
    VerificationReport,
    iter_segments,
)
from prism.stages.checks import CheckContext, run_checks
from prism.stages.extract import norm_text

log = logging.getLogger(__name__)

JUDGED = (ClaimType.AFS, ClaimType.EXTERNAL)                    # sentences that need support from a source
LABEL_ONLY = (ClaimType.ASSUMPTION, ClaimType.PROPOSAL, ClaimType.UNKNOWN)
JUDGE_EXAMPLES = "judge_examples.yaml"                           # optional few-shot examples, kb/judge_examples.yaml
CLIENT_COVERAGE = 0.6                                            # share of a CLIENT sentence's words found in the enquiry
QUOTE_COVERAGE = 0.6                                             # share of a rewritten sentence's words found in its quotes

_WORD = re.compile(r"[a-zà-ÿ0-9µ]+")
_STOP = frozenset({
    "a", "an", "and", "are", "as", "at", "be", "been", "being", "but", "by", "can", "could", "did",
    "do", "does", "for", "from", "had", "has", "have", "how", "if", "in", "into", "is", "it", "its",
    "may", "might", "more", "most", "must", "no", "not", "of", "on", "or", "our", "over", "per",
    "should", "so", "some", "such", "than", "that", "the", "their", "them", "then", "there", "these",
    "they", "this", "those", "to", "under", "up", "use", "used", "uses", "using", "was", "we", "were",
    "what", "when", "where", "which", "while", "who", "will", "with", "within", "without", "would",
    "you", "your",
})
_CLIENT_WORDS = frozenset({
    "client", "customer", "clients", "customers", "states", "stated", "says", "said", "wants", "want",
    "needs", "need", "mentions", "mentioned", "asks", "asked", "reports", "reported", "enquiry",
    "question", "request", "requests", "describes", "described",
})
# A published result presented under a label that needs no source: the label is dishonest.
_PUBLISHED = re.compile(r"\b(studies|literature|publications?|papers?|research)\s+(?:has\s+|have\s+)?(?:show|shows|"
                        r"showed|shown|indicate|indicates|report|reports|confirm|confirms|demonstrate|demonstrates)\b|"
                        r"\b(?:has|have|was|were)\s+been\s+(?:shown|demonstrated|reported|published|proven|"
                        r"established)\b|\bAFS\s+(?:materials?|sources?|slides?)\s+(?:show|state|document)s?\b",
                        re.IGNORECASE)


class JudgeVerdict(BaseModel):
    id: str
    verdict: Literal["supported", "partial", "unsupported", "scope_exceeded"]
    reason: str = ""


class JudgeResult(BaseModel):
    verdicts: list[JudgeVerdict] = Field(default_factory=list)


def content_words(text: str) -> list[str]:
    return [w for w in _WORD.findall(text.lower()) if len(w) >= 3 and w not in _STOP]


def _stem(word: str) -> str:
    return word[:5]


def coverage(text: str, reference: str, ignore: frozenset[str] = frozenset()) -> float:
    """Share of the content words of `text` that occur (by 5-letter stem) in `reference`."""
    words = [w for w in content_words(text) if w not in ignore]
    if not words:
        return 1.0
    have = {_stem(w) for w in content_words(reference)}
    return sum(1 for w in words if _stem(w) in have) / len(words)


def client_grounded(text: str, sources: list[str]) -> bool:
    """A CLIENT sentence must rest on the client's own words: most of its content is in the enquiry or chat."""
    source = " ".join(sources)
    if fuzz.partial_ratio(norm_text(text), norm_text(source)) >= 90:
        return True
    return coverage(text, source, _CLIENT_WORDS) >= CLIENT_COVERAGE


def cited_text(cards: dict[str, Card], seg: Segment) -> str:
    return " ".join(f"{cards[i].quote} {cards[i].claim}" for i in seg.evidence_ids if i in cards)


def gate_issues(body: ReportBody, source_texts: list[str]) -> list[Issue]:
    """Claim-type gate, checked in code. CLIENT sentences must come from the enquiry; ASSUMPTION, PROPOSAL and UNKNOWN
    are checked for honest labelling only (a published result needs a source and the AFS or EXTERNAL label)."""
    out = []
    for path, seg in iter_segments(body):
        if seg.claim_type == ClaimType.CLIENT and not client_grounded(seg.text, source_texts):
            out.append(Issue(check_id="C-SUPPORT", path=path, message="client claim is not in the client's words"))
        elif seg.claim_type in LABEL_ONLY and not seg.evidence_ids and _PUBLISHED.search(seg.text):
            out.append(Issue(check_id="C-SUPPORT", path=path,
                             message=f"label: states a published result as {seg.claim_type.value} without a source"))
    return out


def quote_overlap_issues(body: ReportBody, cards: dict[str, Card], paths: set[str]) -> list[Issue]:
    """Rewritten AFS and EXTERNAL sentences must stay within their quotes (a deterministic stand-in for the judge)."""
    out = []
    for path, seg in iter_segments(body):
        if path in paths and seg.claim_type in JUDGED and coverage(seg.text, cited_text(cards, seg)) < QUOTE_COVERAGE:
            out.append(Issue(check_id="C-SUPPORT", path=path, message="rewritten sentence goes beyond its quotes"))
    return out


def _verbatim_claim(seg: Segment, cards: dict[str, Card]) -> bool:
    """The sentence is a cited card's own claim, word for word: supported by construction, nothing to judge."""
    return any(norm_text(seg.text) == norm_text(cards[i].claim) for i in seg.evidence_ids if i in cards)


def judge_claims(body: ReportBody, cards: dict[str, Card], skip: set[str]) -> list[dict]:
    """The sentences for the support judge: AFS and EXTERNAL sentences that passed the earlier layers."""
    claims = []
    for path, seg in iter_segments(body):
        if seg.claim_type not in JUDGED or path in skip or _verbatim_claim(seg, cards):
            continue
        quotes = [f"[{i} | {cards[i].scope.value}] {cards[i].quote}" for i in seg.evidence_ids if i in cards]
        claims.append({"id": f"c{len(claims) + 1}", "path": path, "text": seg.text, "quotes": quotes})
    return claims


def load_judge_examples(kb: KnowledgeBase, limit: int = 12) -> list[dict]:
    """Few-shot examples from kb/judge_examples.yaml (expert-labelled sentences), when the file exists."""
    path = kb.root / JUDGE_EXAMPLES
    if not path.exists():
        return []
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or []
    except (OSError, yaml.YAMLError) as exc:
        log.warning("judge examples not loaded: %s", exc)
        return []
    out = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict) or not item.get("claim") or item.get("verdict") not in (
                "supported", "partial", "unsupported"):
            continue
        quotes = item.get("quotes") or item.get("quote") or []
        out.append({"claim": str(item["claim"]), "quotes": [quotes] if isinstance(quotes, str) else list(quotes),
                    "verdict": item["verdict"], "reason": str(item.get("reason", ""))})
    return out[:limit]


def verify(body: ReportBody, sheet: RequirementsSheet, findings: RuleFindings, pack: EvidencePack,
           kb: KnowledgeBase, source_texts: list[str], gateway=None, client_question=(), role: str = "judge",
           computed_texts: list[str] | None = None, examples: list[dict] | None = None) -> VerificationReport:
    """Deterministic checks, the claim-type gate, then one judge call for the remaining AFS/EXTERNAL sentences."""
    cx = CheckContext(body, sheet, findings, pack, kb, list(source_texts), list(computed_texts or []))
    issues = run_checks(cx) + gate_issues(body, list(source_texts))
    verdicts: list[ClaimVerdict] = []
    judge_model = ""
    cards = {**kb.cards, **{c.id: c for c in pack.cards}}
    failing = {i.path for i in issues if i.severity == "error"}
    claims = judge_claims(body, cards, failing)
    if gateway is not None and claims:
        prompt, _ = render("judge.j2", claims=claims,
                           examples=examples if examples is not None else load_judge_examples(kb))
        res = gateway.complete(role, [{"role": "user", "content": prompt}], schema=JudgeResult)
        judge_model = res.model
        paths = {c["id"]: c["path"] for c in claims}
        for v in res.parsed.verdicts:
            path = paths.get(v.id)
            if path is None:
                continue
            verdict = "unsupported" if v.verdict == "scope_exceeded" else v.verdict
            verdicts.append(ClaimVerdict(path=path, verdict=verdict, reason=v.reason))
            if verdict == "unsupported":
                issues.append(Issue(check_id="C-SUPPORT", path=path, message=f"unsupported: {v.reason}".strip()))
            elif verdict == "partial":
                issues.append(Issue(check_id="C-SUPPORT", path=path, message=f"partial: {v.reason}".strip(),
                                    severity="warning"))
    return VerificationReport(issues=issues, verdicts=verdicts, judge_model=judge_model)
