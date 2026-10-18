"""Task 21b: hardening found in the first live run. All runs use FakeGateway (no network)."""
from pathlib import Path

import pytest
from pydantic import ValidationError

from prism.assist.sections import AnswerSection, PlanSection, with_application_candidates
from prism.cases import sha256_text
from prism.orchestrator import Pipeline, PipelineFlags
from prism.rules.engine import evaluate
from prism.schemas import (
    ClaimType,
    Enquiry,
    Fact,
    Premise,
    PremiseCheck,
    PremiseVerdict,
    Recommendation,
    RecRole,
    RequirementsSheet,
    Risk,
    SourceRef,
    Stream,
    Target,
)
from prism.stages.checks import CheckContext, check_numbers
from prism.stages.render import build_report, evidence_strength, spectral_range_for, to_markdown
from prism.stages.retrieve import Retriever
from tests.factories import make_sheet, minimal_body, seg
from tests.fakes import judged_answer, workflow_fake

MAT = Path(__file__).resolve().parents[1] / "materials"
META = {"run_id": "abc", "created_at": "2026-10-18T10:00:00Z", "profile": "test", "model_ids": {},
        "prompt_hashes": {}}
ENQUIRY = ("We want to follow fat and protein in an opaque liquid dairy concentrate on the production line. "
           "Can we compare two measurement options?")


def dairy_sheet() -> RequirementsSheet:
    return RequirementsSheet(
        client_question=["Can we compare two measurement options?"],
        streams=[Stream(id="s1", name="main",
                        targets=[Target(name="fat", quote="fat"), Target(name="protein", quote="protein")],
                        matrix=Fact(value="liquid", quote="liquid"), optics=Fact(value="opaque", quote="opaque"))],
        use_context=Fact(value="production", quote="production line"),
        requested_certainty=Fact(value="compare", quote="compare two measurement options"),
        domain="dairy_food")


def enquiry(text: str = ENQUIRY) -> Enquiry:
    return Enquiry(case_id="T", title="Dairy", text=text, sha256=sha256_text(text))


def rec(method: str, technique: str, role: RecRole = RecRole.PRIMARY) -> Recommendation:
    return Recommendation(methods=[method], technique=technique, role=role,
                          rationale=[seg("In-line NIR reflection is used for opaque dairy products.", ClaimType.AFS,
                                         ["S01-p17-nir-reflection-opaque"])])


# 1 -------------------------------------------------------------------------------------------------------------
def test_method_names_are_canonical():
    with pytest.raises(ValidationError):
        Recommendation(methods=["NIR / reflection"], technique="reflection", role=RecRole.PRIMARY,
                       rationale=[seg()])
    assert rec("UV-Vis", "ATR probe").methods == ["UV-Vis"]


# 2 -------------------------------------------------------------------------------------------------------------
def test_evidence_strength_prefers_same_domain_process_evidence(kb):
    findings = with_application_candidates(evaluate(dairy_sheet(), kb), dairy_sheet(), kb)
    assert evidence_strength(rec("NIR", "diffuse reflection probe"), findings) == "Strong"
    assert evidence_strength(rec("Raman", "Raman probe"), findings) != "Strong"


def test_evidence_strength_follows_the_geometry_the_recommendation_names(kb):
    """A geometry the engine scores 0 on the stated optics is never 'Strong', whatever better geometry the same
    method has (a conditional transmission recommendation for an opaque product)."""
    findings = with_application_candidates(evaluate(dairy_sheet(), kb), dairy_sheet(), kb)
    transmission = rec("NIR", "transmission or transflection probe", RecRole.CONDITIONAL)
    assert evidence_strength(transmission, findings) == "Weak"
    assert evidence_strength(rec("NIR", "diffuse reflection probe"), findings) == "Strong"


# 3 -------------------------------------------------------------------------------------------------------------
def test_requirements_are_filled_from_the_sheet(kb):
    sheet = dairy_sheet()
    findings = evaluate(sheet, kb)
    body = minimal_body()
    body.requirements.stated_facts = []          # whatever the LLM wrote is replaced
    r = build_report(body, enquiry(), sheet, findings, kb, META, {})
    stated = {f.slot for f in r.requirements.stated_facts}
    assert stated == {"streams.s1.targets", "streams.s1.matrix", "streams.s1.optics", "use_context",
                      "requested_certainty"}
    assert all(f.quote in ENQUIRY for f in r.requirements.stated_facts)
    assert {f.value for f in r.requirements.stated_facts if f.slot == "streams.s1.targets"} == {"fat", "protein"}
    assert {u.slot for u in r.requirements.key_unknowns} == set(sheet.unknown_slots())
    seeds = {q.slot for q in findings.question_seeds}
    for u in r.requirements.key_unknowns:
        assert u.why_it_matters
        if u.slot not in seeds:
            assert u.why_it_matters == "Not stated by the client."


# 4 -------------------------------------------------------------------------------------------------------------
def test_spectral_ranges_are_filled_per_recommended_method(kb):
    sheet = dairy_sheet()
    findings = evaluate(sheet, kb)
    recs = [rec("NIR", "diffuse reflection probe"), rec("MIR", "ATR probe", RecRole.COMPARISON),
            rec("Raman", "Raman probe", RecRole.SCREENING), rec("UV-Vis", "ATR probe", RecRole.CONDITIONAL),
            rec("Fluorescence", "fluorimetric probe", RecRole.NOT_RECOMMENDED)]
    r = build_report(minimal_body(recommendations=recs, spectral_ranges=[]), enquiry(), sheet, findings, kb, META, {})
    assert [s.method for s in r.spectral_ranges] == ["NIR", "MIR", "Raman", "UV-Vis"]
    nir = r.spectral_ranges[0]
    assert nir.nominal_range == "780–2500 nm" and nir.excitation_nm is None
    assert "VIS-NIR silica fiber" in nir.fiber_family_needed
    assert r.spectral_ranges[1].nominal_range == "4000–400 cm⁻¹ (2.5–25 µm)"
    assert r.spectral_ranges[2].nominal_range == "Raman shift in cm⁻¹; detection region 400–1100 nm"
    assert all(s.caveat[0].claim_type == ClaimType.AFS and s.caveat[0].evidence_ids for s in r.spectral_ranges)
    pack = Retriever(kb).pack(sheet, findings)
    issues = check_numbers(CheckContext(r, sheet, findings, pack, kb, [ENQUIRY]))
    assert [i for i in issues if i.path.startswith("spectral_ranges")] == []
    cited = {s.id for s in r.sources}
    assert {"S01-p10-nir-range", "S01-p09-mir-range", "S01-p11-raman-region"} <= cited
    # an LLM entry with a canonical method is kept
    kept = build_report(minimal_body(), enquiry(), sheet, findings, kb, META, {})
    assert [s.fiber_family_needed for s in kept.spectral_ranges] == ["VIS-NIR silica"]
    assert spectral_range_for("Fluorescence", kb).method == "Fluorescence"


# 5 -------------------------------------------------------------------------------------------------------------
def test_rule_ids_are_not_premises(kb):
    sheet = dairy_sheet()
    # Task 21c: premise checks are kept only when they match a client premise on the sheet.
    sheet.premises = [Premise(type="reuse_asset", text="Reuse the existing analyser", quote="existing analyser")]
    checks = [PremiseCheck(premise="R-HOT-FOULING", verdict=PremiseVerdict.UNVERIFIABLE, explanation=[seg()]),
              PremiseCheck(premise="Reuse the existing analyser", verdict=PremiseVerdict.UNVERIFIABLE,
                           explanation=[seg()])]
    r = build_report(minimal_body(premise_checks=checks), enquiry(), sheet, evaluate(sheet, kb), kb, META, {})
    assert [p.premise for p in r.premise_checks] == ["Reuse the existing analyser"]
    rule_id = next(iter(kb.rules_meta))
    assert rule_id.startswith("R-")


# 6 and 7 -------------------------------------------------------------------------------------------------------
GUARANTEE = "This concept guarantees reliable results."
DELETE = {"patches": [{"id": "s1", "action": "delete"}]}


def pipeline_run(kb, plan, deep=False, patches=(DELETE,)):
    text = "We need to monitor water content in a liquid stream. What should we test first?"
    sheet = make_sheet(matrix="liquid", targets=("water content",))
    gw = workflow_fake(sheet, sections={PlanSection: plan, AnswerSection: judged_answer(kb, sheet)},
                       patcher=list(patches))
    result = Pipeline(gw, kb, MAT, PipelineFlags(deep=deep)).run(
        Enquiry(case_id="T1", title="Water", text=text, sha256=sha256_text(text)))
    return result, gw


def guarantee_plan():
    return PlanSection(decision_basis=[seg("Error and bias on independent runs."), seg(GUARANTEE)])


def test_compliance_is_computed_after_patching(kb):
    result, _ = pipeline_run(kb, guarantee_plan())
    assert "patch" in result.manifest.timings
    assert [s.text for s in result.report.decision_basis] == ["Error and bias on independent runs."]
    assert result.report.compliance["P-NO-GUARANTEE"] is True
    assert not any(i.check_id == "P-NO-GUARANTEE" for i in result.verification.issues)


def test_judge_runs_once_even_with_patching(kb):
    _, gw = pipeline_run(kb, guarantee_plan())
    roles = [r["role"] for r in gw.requests]
    assert roles.count("judge") == 1 and "judge_deep" not in roles
    assert roles.count("writer") == 3 and roles.count("patcher") == 1 and "generator" not in roles
    _, gw = pipeline_run(kb, guarantee_plan(), deep=True)
    roles = [r["role"] for r in gw.requests]
    assert roles.count("judge_deep") == 1 and "judge" not in roles and roles.count("writer_deep") == 3
    assert roles.count("patcher") == 1


def test_judge_issue_carries_only_when_text_is_unchanged():
    from prism.orchestrator import carried_judge_issues
    from prism.schemas import Issue
    before = minimal_body(decision_basis=[seg("Error and bias on independent runs."), seg(GUARANTEE)])
    issue = Issue(check_id="C-SUPPORT", path="decision_basis[1]", message="unsupported: not in the quotes")
    assert carried_judge_issues([issue], before, before) == [issue]
    after = minimal_body(decision_basis=[seg("Error and bias on independent runs.")])
    assert carried_judge_issues([issue], before, after) == []


# 8 -------------------------------------------------------------------------------------------------------------
def test_markdown_polish(kb):
    sheet = dairy_sheet()
    body = minimal_body(
        recommendations=[rec("NIR", "NIR / reflection"), rec("MIR", "MIR / ATR", RecRole.COMPARISON)],
        risks=[Risk(risk=[seg("Drift.", ClaimType.ASSUMPTION)], effect="Biased predictions.",
                    mitigation="Vary physical conditions..")],
        premise_checks=[PremiseCheck(premise="Reuse the analyser.", verdict=PremiseVerdict.UNVERIFIABLE,
                                     explanation=[seg()])])
    r = build_report(body, enquiry(), sheet, evaluate(sheet, kb), kb, META, {})
    r.sources.append(SourceRef(id="S01-p10-nir-glass", citation="S01 p.10", quote="q", scope="method_general"))
    md = to_markdown(r)
    assert ".." not in md
    assert "**NIR · reflection**" in md and "**MIR · ATR**" in md
    source_lines = md.split("## Sources")[1].split("[^")[0].strip().splitlines()
    citations = [line[2:].split(" (")[0] for line in source_lines]
    assert len(citations) == len(set(citations))
    assert any(line.startswith("- S01 p.10 (") and "cards:" in line for line in source_lines)
    assert md.count("[^S01-p10-nir-glass]:") == 1
