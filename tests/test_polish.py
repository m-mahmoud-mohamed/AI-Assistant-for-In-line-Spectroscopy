"""Task 21c: report polish found in the second live run. No network calls."""
from prism.cases import sha256_text
from prism.rules.engine import evaluate
from prism.schemas import (
    ClaimType,
    Enquiry,
    Premise,
    PremiseCheck,
    PremiseVerdict,
    QuestionSeed,
    RuleFindings,
)
from prism.stages.render import build_report, key_unknowns
from tests.factories import make_sheet, minimal_body, seg

META = {"run_id": "abc", "created_at": "2026-10-18T10:00:00Z", "profile": "test", "model_ids": {},
        "prompt_hashes": {}}
TEXT = "Monitor fat in an opaque liquid. We want to reuse our existing NIR analyser."


def _enquiry() -> Enquiry:
    return Enquiry(case_id="T", title="Fat", text=TEXT, sha256=sha256_text(TEXT))


def _report(kb, sheet, body):
    return build_report(body, _enquiry(), sheet, evaluate(sheet, kb), kb, META, {})


def test_premise_check_without_matching_sheet_premise_is_dropped(kb):
    premise = Premise(type="reuse_asset", text="Reuse the existing NIR analyser", method="NIR",
                      quote="reuse our existing NIR analyser")
    sheet = make_sheet(matrix="liquid", optics="opaque", targets=("fat",), domain="dairy_food", premises=(premise,))
    checks = [PremiseCheck(premise="Reuse the existing NIR analyser.", verdict=PremiseVerdict.UNVERIFIABLE,
                           explanation=[seg()]),
              PremiseCheck(premise="The client asks for a comparison experiment",
                           verdict=PremiseVerdict.SUPPORTED, explanation=[seg()])]
    r = _report(kb, sheet, minimal_body(premise_checks=checks))
    assert [p.premise for p in r.premise_checks] == ["Reuse the existing NIR analyser."]
    no_premises = make_sheet(matrix="liquid", optics="opaque", targets=("fat",), domain="dairy_food")
    assert _report(kb, no_premises, minimal_body(premise_checks=checks)).premise_checks == []


def test_leading_claim_labels_are_stripped(kb):
    sheet = make_sheet(matrix="liquid", optics="opaque", targets=("fat",), domain="dairy_food")
    body = minimal_body(decision_basis=[seg("AFS: NIR reflection is used for opaque products.", ClaimType.AFS,
                                            ["S01-p17-nir-reflection-opaque"]),
                                        seg("assumption :The line is accessible.", ClaimType.ASSUMPTION),
                                        seg("Proposal:Start in the laboratory.")])
    r = _report(kb, sheet, body)
    assert [s.text for s in r.decision_basis] == ["NIR reflection is used for opaque products.",
                                                  "The line is accessible.", "Start in the laboratory."]


def test_risk_only_unknown_reads_clearly():
    sheet = make_sheet(matrix="liquid", optics="opaque", targets=("fat",))
    findings = RuleFindings(question_seeds=[
        QuestionSeed(slot="concentration_range", impact="RISK_ONLY", outcomes={"wide": "x", "narrow": "y"}),
        QuestionSeed(slot="distance", impact="TECHNIQUE_CHANGE", text_hint="How far is the analyser?")])
    why = {u.slot: u.why_it_matters for u in key_unknowns(sheet, findings)}
    assert why["concentration_range"] == "Needed for the feasibility plan and acceptance criteria."
    assert why["distance"] == "Can change the probe geometry or interface. How far is the analyser?"
