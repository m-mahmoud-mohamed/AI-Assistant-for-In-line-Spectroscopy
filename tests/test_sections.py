"""Code-side guarantees of the merged report body: the verdict fits the decision status, a provisional direct answer
names its lead method, and a recommendation's restored AFS citation stays inside the evidence pack."""
from __future__ import annotations

import pytest

from prism.assist.sections import (
    AnswerSection,
    build_skeleton,
    clamp_verdict,
    ensure_afs,
    merge,
    slice_pack,
    with_application_candidates,
)
from prism.rules.engine import evaluate
from prism.schemas import ClaimType, DecisionStatus, EvidencePack, RecRole, Verdict
from prism.stages.checks import direct_answer_problems
from prism.stages.retrieve import Retriever
from tests.factories import make_sheet, seg

P, I, O = DecisionStatus.PROVISIONAL, DecisionStatus.INSUFFICIENT_INFORMATION, DecisionStatus.OUTSIDE_SUPPORTED_SCOPE


def context(kb):
    sheet = make_sheet(matrix="liquid", optics="opaque", domain="dairy_food", targets=("fat", "protein"))
    findings = with_application_candidates(evaluate(sheet, kb), sheet, kb)
    pack = Retriever(kb).pack(sheet, findings)
    sk = build_skeleton(sheet, findings, kb)
    return pack, sk, slice_pack(pack, sk, findings, kb)


@pytest.mark.parametrize("status, verdict, expected", [
    (P, Verdict.YES, Verdict.YES), (I, Verdict.YES, Verdict.CONDITIONAL), (I, Verdict.NOT_YET, Verdict.NOT_YET),
    (O, Verdict.CONDITIONAL, Verdict.NOT_YET), (O, Verdict.YES, Verdict.NOT_YET), (O, Verdict.NO, Verdict.NO),
    (O, Verdict.NOT_APPLICABLE, Verdict.NOT_APPLICABLE)])
def test_the_verdict_never_claims_more_than_the_status(status, verdict, expected):
    assert clamp_verdict(verdict, status) == expected


def test_a_provisional_answer_that_names_no_method_gets_the_lead_sentence(kb):
    pack, sk, slices = context(kb)
    assert sk.status == P
    vague = AnswerSection(direct_answer=[seg("A probe-based measurement looks possible.", ClaimType.PROPOSAL)],
                          verdict="CONDITIONAL")
    body = merge(sk, kb, pack, {"answer": vague}, slices).body
    lead = next(r for r in sk.recs if r.role == RecRole.PRIMARY)
    added = body.direct_answer.text[-1]
    assert len(body.direct_answer.text) == 2 and added.claim_type == ClaimType.PROPOSAL
    assert lead.methods[0] in added.text and lead.technique in added.text
    assert direct_answer_problems(body, kb.lexicon.get("methods", {})) == []


def test_a_direct_answer_that_names_the_lead_method_is_left_alone(kb):
    pack, sk, slices = context(kb)
    lead = next(r for r in sk.recs if r.role == RecRole.PRIMARY)
    named = AnswerSection(direct_answer=[seg(f"{lead.methods[0]} is the first option to test.", ClaimType.PROPOSAL)],
                          verdict="CONDITIONAL")
    body = merge(sk, kb, pack, {"answer": named}, slices).body
    assert [s.text for s in body.direct_answer.text] == [f"{lead.methods[0]} is the first option to test."]


def test_a_restored_afs_citation_stays_inside_the_evidence_pack(kb):
    pack, sk, slices = context(kb)
    body = merge(sk, kb, pack, {}, slices).body
    rec, rs = body.recommendations[0], sk.recs[0]
    rec.rationale, rec.conditions, rec.limitations = [], [], []             # every sentence was stripped
    in_pack = [c for c in pack.cards if c.id in rs.evidence_ids and c.source.startswith("S0")]
    assert in_pack, "the fixture needs one AFS card of the lead recommendation in the pack"
    first_fallback = set(rs.fallback[0].evidence_ids)
    narrow = EvidencePack(cards=[c for c in pack.cards if c.id not in first_fallback] or in_pack,
                          reasons=dict(pack.reasons))
    known = {c.id for c in narrow.cards}
    restored = ensure_afs(body, sk, kb, narrow).recommendations[0].rationale
    assert restored and all(i in known for s in restored for i in s.evidence_ids)
