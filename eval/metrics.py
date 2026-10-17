"""Per-case quality metrics for a pipeline run, and their aggregation per configuration.

Metrics that do not apply to a run (e.g. claim support when the critic did not run, or report metrics for a
refused enquiry) are None and are skipped by aggregate(), never counted as 0.
"""
from __future__ import annotations

from collections.abc import Iterable, Sequence
from pathlib import Path

from prism.kb.loader import KnowledgeBase, page_text, quote_found
from prism.orchestrator import RunResult
from prism.schemas import (
    AssessmentReport,
    Card,
    Issue,
    PremiseVerdict,
    RecRole,
    ReportBody,
    ScopeLabel,
    iter_segments,
)
from prism.stages.checks import CheckContext, run_checks
from prism.stages.extract import grounded

DEFAULT_KB = Path(__file__).resolve().parents[1] / "kb"
METRIC_KEYS = ("schema_ok", "citation_existence", "quote_fidelity", "claim_support", "invented_numbers",
               "fact_fidelity", "questions_ok", "plan_ok", "trap_handled", "screening_ok", "scope_ok", "latency_s")
PLAN_SECTIONS = ("samples_and_states", "reference_measurements", "setup", "comparison", "validation", "go_no_go",
                 "not_demonstrated")
FLAGGED = (PremiseVerdict.CONTRADICTED, PremiseVerdict.UNVERIFIABLE)


def _share(hits: int, total: int) -> float | None:
    return hits / total if total else None


def _body(report: AssessmentReport) -> ReportBody:
    return ReportBody.model_validate(report.model_dump(include=set(ReportBody.model_fields)))


def _schema_ok(report: AssessmentReport) -> bool:
    try:
        again = AssessmentReport.model_validate_json(report.model_dump_json())
    except ValueError:
        return False
    return bool(again.recommendations and again.measurement_concept and again.direct_answer.text
                and again.decision_basis and again.feasibility_plan.steps)


def _cited_ids(report: AssessmentReport) -> list[str]:
    ids = [cid for _, s in iter_segments(_body(report)) for cid in s.evidence_ids]
    return list(dict.fromkeys(ids))


def _quote_on_page(card: Card, kb: KnowledgeBase | None) -> bool | None:
    if card.source == "EXT":
        return None                                    # external cards carry a URL, not a page of S01–S05
    if card.source == "TABLE":
        if kb is None:
            return None
        return card.quote in [t["table_row"] for t in kb.techniques.values()]
    root = kb.root if kb is not None else DEFAULT_KB
    return quote_found(card.quote, page_text(root, card.source, card.page))


def _issues(result: RunResult, kb: KnowledgeBase | None, sources: Sequence[str] | None) -> list[Issue]:
    """Deterministic issues recomputed on the final report when possible, so ablations without the verifier are
    measured with the same checks; otherwise the issues recorded by the run."""
    if kb is not None and sources is not None and result.sheet is not None and result.pack is not None \
            and result.findings is not None:
        return run_checks(CheckContext(_body(result.report), result.sheet, result.findings, result.pack, kb,
                                       list(sources)))
    return list(result.verification.issues)


def _questions_ok(report: AssessmentReport) -> bool:
    qs = report.clarification_questions
    priorities = [q.priority for q in qs]
    return 3 <= len(qs) <= 6 and priorities == sorted(set(priorities)) \
        and all(q.decision_it_changes.strip() for q in qs)


def _plan_ok(report: AssessmentReport) -> bool:
    p = report.feasibility_plan
    return 1 <= len(p.steps) <= 6 and all(getattr(p, name) for name in PLAN_SECTIONS)


def _fact_fidelity(report: AssessmentReport, issues: list[Issue], sources: Sequence[str] | None) -> float | None:
    facts = report.requirements.stated_facts
    if sources is not None:
        return _share(sum(1 for f in facts if grounded(f.quote, list(sources))), len(facts))
    flagged = {i.path for i in issues if i.check_id == "P-NO-SELF-ANSWER"}
    return _share(sum(1 for j in range(len(facts)) if f"requirements.stated_facts[{j}]" not in flagged), len(facts))


def case_metrics(result: RunResult, expect: dict | None, kb: KnowledgeBase | None = None,
                 sources: Sequence[str] | None = None) -> dict:
    """Metrics for one run. `expect` comes from eval/synthetic_cases.yaml (None for dev cases).

    `kb` resolves cited ids outside the evidence pack and table rows; `sources` (enquiry text, title, chat facts)
    enables recomputing the deterministic checks on the final report.
    """
    report = result.report
    refused = report is None
    out: dict = dict.fromkeys(METRIC_KEYS)
    out["latency_s"] = round(sum(result.manifest.timings.values()), 3)
    out["status"] = report.decision_status.value if report else None
    out["scope"] = result.scope.label.value

    if expect is not None:
        out["scope_ok"] = result.scope.label.value == expect.get("scope")
    if refused:
        if expect is not None:
            out["trap_handled"] = expect.get("scope") in (ScopeLabel.OFF_TOPIC.value, ScopeLabel.UNSAFE.value)
        return out

    out["schema_ok"] = _schema_ok(report)
    pack_cards = {c.id: c for c in (result.pack.cards if result.pack else [])}
    cited = _cited_ids(report)
    out["citation_existence"] = _share(sum(1 for cid in cited if cid in pack_cards), len(cited))
    known = [pack_cards.get(cid) or (kb.cards.get(cid) if kb else None) for cid in cited]
    checks = [ok for ok in (_quote_on_page(c, kb) for c in known if c is not None) if ok is not None]
    out["quote_fidelity"] = _share(sum(checks), len(checks))

    verdicts = result.verification.verdicts
    out["claim_support"] = _share(sum(1 for v in verdicts if v.verdict == "supported"), len(verdicts))
    issues = _issues(result, kb, sources)
    out["invented_numbers"] = sum(1 for i in issues if i.check_id == "P-NO-NUMBERS")
    out["fact_fidelity"] = _fact_fidelity(report, issues, sources)
    out["questions_ok"] = _questions_ok(report)
    out["plan_ok"] = _plan_ok(report)

    if expect is not None:
        status_ok = out["status"] in expect.get("status_any_of", [])
        premise_ok = not expect.get("premise_flag") or any(pc.verdict in FLAGGED for pc in report.premise_checks)
        out["trap_handled"] = status_ok and premise_ok
        if expect.get("screening"):
            out["screening_ok"] = any(r.role in (RecRole.SCREENING, RecRole.CONDITIONAL)
                                      for r in report.recommendations)
    return out


def _mean(values: Iterable) -> float | None:
    nums = [float(v) for v in values if v is not None]
    return round(sum(nums) / len(nums), 3) if nums else None


def aggregate(rows: Sequence[dict]) -> dict:
    """Mean of every metric over the rows where it applies (booleans count as 0/1)."""
    out: dict = {"n": len(rows), "errors": sum(1 for r in rows if r.get("error"))}
    keys = [k for k in (*METRIC_KEYS, "judge_score") if any(k in r for r in rows)]
    for key in keys:
        out[key] = _mean(r.get(key) for r in rows)
    out["invented_numbers_total"] = sum(int(r.get("invented_numbers") or 0) for r in rows)
    return out
