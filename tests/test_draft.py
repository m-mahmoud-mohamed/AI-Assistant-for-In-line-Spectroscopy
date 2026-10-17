from prism.cases import sha256_text
from prism.rules.engine import evaluate
from prism.schemas import DecisionStatus, Enquiry, ReportBody
from prism.stages.draft import build_draft_messages, draft
from prism.stages.retrieve import Retriever
from tests.factories import make_sheet, minimal_body
from tests.fakes import FakeGateway

TEXT = "We need to check an unknown contaminant in a liquid. Which sensor exactly?"


def setup(kb):
    sheet = make_sheet(matrix="liquid", targets=("an unknown contaminant",), undefined_targets=True)
    findings = evaluate(sheet, kb)
    pack = Retriever(kb).pack(sheet, findings)
    enquiry = Enquiry(case_id="T", title="t", text=TEXT, sha256=sha256_text(TEXT))
    return enquiry, sheet, findings, pack


def test_prompt_contains_constraints_evidence_and_exemplars(kb):
    enquiry, sheet, findings, pack = setup(kb)
    msgs, phash = build_draft_messages(enquiry, sheet, findings, pack, {"D01": "D01 · example", "D02": "D02 · x"})
    user = msgs[1]["content"]
    assert "R-UNDEFINED-TARGET" in user and "[S01-p03-unknown-composition]" in user
    assert "<enquiry>" in user and "D01 · example" in user and "INSUFFICIENT_INFORMATION" in user
    assert "Do not invent" in msgs[0]["content"] and len(phash) == 12


def test_llm_cannot_loosen_status(kb):
    enquiry, sheet, findings, pack = setup(kb)
    gw = FakeGateway({"generator": [minimal_body(decision_status=DecisionStatus.PROVISIONAL)]})
    body, meta = draft(enquiry, sheet, findings, pack, gw, {})
    assert body.decision_status == DecisionStatus.INSUFFICIENT_INFORMATION
    assert gw.requests[0]["schema"] is ReportBody and meta["model"] == "fake-generator"


def test_deep_role_is_used_when_requested(kb):
    enquiry, sheet, findings, pack = setup(kb)
    gw = FakeGateway({"generator_deep": [minimal_body()]})
    draft(enquiry, sheet, findings, pack, gw, {}, role="generator_deep")
    assert gw.requests[0]["role"] == "generator_deep"
