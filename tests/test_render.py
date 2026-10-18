from prism.cases import sha256_text
from prism.rules.engine import evaluate
from prism.schemas import ClaimType, Enquiry, Issue
from prism.stages.render import build_report, to_markdown
from prism.stages.repair import strip_failing
from tests.factories import make_sheet, minimal_body, seg

HEADINGS = ["## Decision status", "## Direct answer", "## Premise checks", "## Requirements stated",
            "## Key unknowns", "## Clarification questions", "## Recommendation", "## Measurement concept",
            "## Spectral range", "## Risks and uncertainty", "## First feasibility experiment",
            "## Decision basis", "## Sources"]


def report(kb, body=None):
    sheet = make_sheet(matrix="liquid", optics="opaque", targets=("fat",), domain="dairy_food")
    findings = evaluate(sheet, kb)
    text = "Monitor fat in an opaque liquid."
    enquiry = Enquiry(case_id="T", title="Fat", text=text, sha256=sha256_text(text))
    meta = {"run_id": "abc", "created_at": "2026-10-18T10:00:00Z", "profile": "test", "model_ids": {},
            "prompt_hashes": {}}
    return build_report(body or minimal_body(), enquiry, sheet, findings, kb, meta, {"P-QUESTIONS": True})


def test_markdown_follows_worked_example_layout(kb):
    md = to_markdown(report(kb))
    positions = [md.index(h) for h in HEADINGS]
    assert positions == sorted(positions)
    assert '[^S01-p10-nir-range]: S01 p.10 — "NIR spectra (780–2500 nm)' in md


def test_sources_and_strength_are_filled_by_code(kb):
    r = report(kb)
    assert {s.id for s in r.sources} == {"S01-p17-nir-reflection-opaque", "S01-p10-nir-range"}
    assert r.recommendations[0].evidence_strength in ("Strong", "Moderate", "Weak")


def test_strip_failing_removes_segment_and_keeps_model_valid():
    body = minimal_body(decision_basis=[seg("Bad claim.", ClaimType.AFS, ["X"]), seg("Good claim.")])
    fixed = strip_failing(body, [Issue(check_id="C-IDS", path="decision_basis[0]", message="x")])
    assert [s.text for s in fixed.decision_basis] == ["Good claim."]
    lone = strip_failing(minimal_body(), [Issue(check_id="C-SUPPORT", path="recommendations[0].rationale[0]",
                                                message="x")])
    assert lone.recommendations[0].rationale[0].claim_type == ClaimType.ASSUMPTION
    assert lone.recommendations[0].role.value == "CONDITIONAL"
