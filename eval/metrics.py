"""Per-case quality metrics for a pipeline run, and their aggregation per configuration.

Metrics that do not apply to a run (e.g. claim support when the critic did not run, report metrics for a refused
enquiry, or a gold field the case does not define) are None and are skipped by aggregate(), never counted as 0.

Three groups:
- report quality (METRIC_KEYS), computed from the final report as before;
- agreement with the gold fields of a case (GOLD_KEYS): decision status, primary method family, probe technique,
  premise verdicts, must-cite pages, one concept per stream;
- run behaviour (RUN_KEYS) from the event log and the recorded LLM calls: time to verdict and to the full report,
  calls and tokens, direct-answer consistency, question value, patching and writer truncation.
aggregate() adds bootstrap 95 % confidence intervals over cases, latency percentiles and the pooled judge verdicts.
"""
from __future__ import annotations

from collections.abc import Iterable, Sequence
from pathlib import Path

from eval.recorder import WRITER_ROLES, usage_numbers
from eval.stats import mean_ci, percentile, pooled_share_ci
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
from prism.stages.checks import CheckContext, direct_answer_problems, run_checks
from prism.stages.extract import grounded

DEFAULT_KB = Path(__file__).resolve().parents[1] / "kb"
METRIC_KEYS = ("schema_ok", "citation_existence", "quote_fidelity", "claim_support", "invented_numbers",
               "fact_fidelity", "questions_ok", "plan_ok", "trap_handled", "screening_ok", "scope_ok", "latency_s")
GOLD_KEYS = ("status_agreement", "method_agreement", "technique_agreement", "premise_agreement", "cite_recall",
             "streams_ok")
RUN_KEYS = ("time_to_verdict", "time_to_report", "llm_calls", "llm_live_calls", "tokens_in", "tokens_out",
            "direct_answer_consistent", "question_value", "questions_asked", "patched", "patch_actions",
            "writer_fallback", "writer_truncation", "writer_out_tokens", "writer_out_tokens_max")
VERDICTS = ("supported", "partial", "unsupported")
VERDICT_KEYS = tuple(f"judge_{v}" for v in VERDICTS)          # counts per run; pooled into shares by aggregate()
TIME_KEYS = ("time_to_verdict", "time_to_report")
NO_CI = ("latency_s", "llm_calls", "llm_live_calls", "tokens_in", "tokens_out", "questions_asked", "patch_actions",
         "writer_out_tokens", "writer_out_tokens_max", "judge_score")
PLAN_SECTIONS = ("samples_and_states", "reference_measurements", "setup", "comparison", "validation", "go_no_go",
                 "not_demonstrated")
FLAGGED = (PremiseVerdict.CONTRADICTED, PremiseVerdict.UNVERIFIABLE)
DECISION_IMPACTS = ("STATUS_CHANGE", "PRIMARY_METHOD_CHANGE", "TECHNIQUE_CHANGE")   # a question that can change it
TOP_QUESTIONS = 3
WRITER_SECTIONS = 3                                      # answer, concept, plan
CAP_SHARE = 0.98                                         # output tokens at this share of max_tokens = truncated
PREPARE_STAGES = ("scope", "extract", "normalise", "rules")


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


def _scopes(expect: dict) -> list[str]:
    scope = expect.get("scope")
    return list(scope) if isinstance(scope, (list, tuple)) else [scope]


# ---------------------------------------------------------------- gold agreement

def primary_recommendations(report: AssessmentReport) -> list:
    """The recommendations that carry the method choice: PRIMARY, else the first CONDITIONAL one."""
    primary = [r for r in report.recommendations if r.role == RecRole.PRIMARY]
    if primary:
        return primary
    return [r for r in report.recommendations if r.role == RecRole.CONDITIONAL][:1]


def primary_methods(report: AssessmentReport) -> list[str]:
    return list(dict.fromkeys(m for r in primary_recommendations(report) for m in r.methods))


def premise_agreement(verdicts: Sequence[str], expected: Sequence) -> bool:
    """Each expected verdict (or list of acceptable verdicts) is matched by a distinct premise check; when nothing is
    expected, no premise may be flagged (CONTRADICTED or UNVERIFIABLE)."""
    if not expected:
        return not any(v in (PremiseVerdict.CONTRADICTED.value, PremiseVerdict.UNVERIFIABLE.value) for v in verdicts)
    wanted = sorted(([e] if isinstance(e, str) else list(e) for e in expected), key=len)
    left = list(verdicts)
    for options in wanted:
        hit = next((v for v in left if v in options), None)
        if hit is None:
            return False
        left.remove(hit)
    return True


def cited_citations(report: AssessmentReport, cards: dict[str, Card]) -> set[str]:
    """Every source page the report cites ("S01 p.17", "S01 Table 1 (p.6)")."""
    out = {s.citation for s in report.sources}
    out |= {cards[cid].citation() for cid in _cited_ids(report) if cid in cards}
    return out


def gold_metrics(report: AssessmentReport | None, expect: dict, cards: dict[str, Card]) -> dict:
    out: dict = dict.fromkeys(GOLD_KEYS)
    if expect.get("status"):
        out["status_agreement"] = report is not None and report.decision_status.value == expect["status"]
    if expect.get("methods"):
        out["method_agreement"] = report is not None and bool(set(primary_methods(report)) & set(expect["methods"]))
    if expect.get("techniques"):
        techs = [r.technique.lower() for r in primary_recommendations(report)] if report is not None else []
        out["technique_agreement"] = any(t.lower() in tech for t in expect["techniques"] for tech in techs)
    if "premises" in expect and expect["premises"] is not None:
        out["premise_agreement"] = report is not None and premise_agreement(
            [pc.verdict.value for pc in report.premise_checks], expect["premises"])
    if expect.get("cite"):
        cited = cited_citations(report, cards) if report is not None else set()
        out["cite_recall"] = sum(1 for c in expect["cite"] if c in cited) / len(expect["cite"])
    if expect.get("streams"):
        concepts = {mc.stream_id for mc in report.measurement_concept} if report is not None else set()
        out["streams_ok"] = len(concepts) >= int(expect["streams"])
    return out


# ---------------------------------------------------------------- run behaviour (event log and LLM calls)

def _first(events: Sequence[dict], type_: str, last: bool = False) -> dict | None:
    hits = [e for e in events if e.get("type") == type_]
    return (hits[-1] if last else hits[0]) if hits else None


def event_times(events: Sequence[dict], timings: dict[str, float] | None = None) -> tuple[float | None, float | None]:
    """(time to verdict, time to full report) in seconds. Verdict = `engine_ready` (the end of prepare), report =
    `run_completed`, both from the run's first event; without event times, the manifest's stage timings."""
    start = events[0].get("ts") if events else None
    ready, done = _first(events, "engine_ready"), _first(events, "run_completed", last=True)
    verdict = report = None
    if start is not None and ready is not None and ready.get("ts") is not None:
        verdict = round(ready["ts"] - start, 3)
    if start is not None and done is not None and done.get("ts") is not None:
        report = round(done["ts"] - start, 3)
    if timings:
        if verdict is None and ready is not None:
            verdict = round(sum(timings.get(s, 0.0) for s in PREPARE_STAGES), 3)
        if report is None and done is not None:
            report = round(sum(timings.values()), 3)
    return verdict, report


def question_value(questions: Sequence[dict], top: int = TOP_QUESTIONS) -> float | None:
    """Share of the top questions of the clarify gate whose options can change the decision: the status, the
    primary method or the probe technique (C2 ClarifyQuestion.impact; RISK_ONLY only sharpens the plan)."""
    shown = [q for q in questions if isinstance(q, dict)][:top]
    return _share(sum(1 for q in shown if q.get("impact") in DECISION_IMPACTS), len(shown))


def gate_questions(events: Sequence[dict], manifest: dict | None = None,
                   ranked: Sequence[dict] | None = None) -> tuple[list[dict] | None, list[dict] | None]:
    """(the gate's ranking, the questions put to the scientist at `engine_ready`), as C2 ClarifyQuestion dicts.

    The ranking is the gate's full list (the runner stores `Prepared.ranked` as questions.json), else a `questions`
    list in the manifest, else the asked questions of `engine_ready`. The asked ones are filtered to questions that
    can change the decision, so question value read from them alone is high by construction. None = the run never
    reached the engine."""
    ready = _first(events, "engine_ready", last=True)
    asked = list(ready.get("payload", {}).get("questions") or []) if ready is not None else None
    if ranked is not None:
        return list(ranked), asked
    if manifest and isinstance(manifest.get("questions"), list):
        return list(manifest["questions"]), asked
    return asked, asked


def patch_stats(events: Sequence[dict]) -> tuple[bool | None, int | None]:
    """(the patch stage ran, sentences it changed) from the event log."""
    if not events:
        return None, None
    ran = any(e.get("type") == "stage_started" and e.get("stage") == "patch" for e in events)
    actions = sum(len(e.get("payload", {}).get("actions") or []) for e in events if e.get("type") == "repaired")
    return ran, actions


def usage_stats(calls: Sequence[dict]) -> dict:
    """Calls and tokens of one run from the recorded calls (cached responses count with their recorded usage, so a
    replayed run reports what the report costs; `llm_live_calls` are the ones that reached a provider)."""
    out: dict = {"llm_calls": len(calls), "llm_live_calls": sum(1 for c in calls if not c.get("cached")),
                 "tokens_in": 0, "tokens_out": 0, "calls_by_role": {}, "tokens_by_model": {},
                 "writer_tokens_by_section": {}}
    writer_out: list[int] = []
    at_cap = 0
    for c in calls:
        role = c.get("role", "")
        out["calls_by_role"][role] = out["calls_by_role"].get(role, 0) + 1
        if c.get("error"):
            continue
        u = usage_numbers(c.get("usage", {}))
        produced = u["completion"] + u["thinking"]
        out["tokens_in"] += u["prompt"]
        out["tokens_out"] += produced
        model = out["tokens_by_model"].setdefault(c.get("model") or "?", {"in": 0, "out": 0, "cached": 0})
        model["in"] += u["prompt"]
        model["out"] += produced
        model["cached"] += u["cached"]
        if role in WRITER_ROLES:
            writer_out.append(u["completion"])
            section = str(c.get("schema") or "?").removesuffix("Section").lower()     # AnswerSection -> answer
            out["writer_tokens_by_section"][section] = u["completion"]
            cap = c.get("max_tokens")
            if c.get("finish_reason") == "length" or (cap and u["completion"] >= CAP_SHARE * cap):
                at_cap += 1
    out["writer_out_tokens"] = round(sum(writer_out) / len(writer_out), 1) if writer_out else None
    out["writer_out_tokens_max"] = max(writer_out) if writer_out else None
    out["writer_at_cap"] = at_cap
    return out


def writer_stats(issues: Sequence[Issue], at_cap: int | None) -> tuple[float, float | None]:
    """(share of the writer sections filled by code after the writer failed — the W-WRITER issue rate,
    share of the writer sections cut off at max_tokens — failed as truncated, or answered at the cap)."""
    failed = [i for i in issues if i.check_id == "W-WRITER"]
    truncated = sum(1 for i in failed if "truncated" in i.message)
    fallback = min(1.0, len(failed) / WRITER_SECTIONS)
    if at_cap is None and not truncated:
        return fallback, None
    return fallback, min(1.0, (truncated + (at_cap or 0)) / WRITER_SECTIONS)


def verdict_counts(verdicts: Iterable) -> dict[str, int]:
    out = dict.fromkeys(VERDICT_KEYS, 0)
    for v in verdicts:
        verdict = getattr(v, "verdict", None) or (v.get("verdict") if isinstance(v, dict) else None)
        verdict = "unsupported" if verdict == "scope_exceeded" else verdict
        if verdict in VERDICTS:
            out[f"judge_{verdict}"] += 1
    return out


def run_metrics(events: Sequence[dict], calls: Sequence[dict] | None, issues: Sequence[Issue], verdicts: Iterable,
                timings: dict[str, float] | None = None, manifest: dict | None = None,
                ranked: Sequence[dict] | None = None) -> dict:
    """Run-behaviour metrics from what an evaluation run stores per case (events, calls, issues, verdicts, and the
    clarify gate's ranking when the runner recorded it)."""
    out: dict = dict.fromkeys(RUN_KEYS)
    out["time_to_verdict"], out["time_to_report"] = event_times(events, timings)
    questions, asked = gate_questions(events, manifest, ranked)
    if questions is not None:
        out["question_value"] = question_value(questions)
    if asked is not None:
        out["questions_asked"] = len(asked)
    out["patched"], out["patch_actions"] = patch_stats(events)
    at_cap = None
    if calls is not None:
        usage = usage_stats(calls)
        at_cap = usage.pop("writer_at_cap")
        out |= usage
    if any(e.get("stage") == "write" for e in events) or any(i.check_id == "W-WRITER" for i in issues):
        out["writer_fallback"], out["writer_truncation"] = writer_stats(issues, at_cap)
    out |= verdict_counts(verdicts)
    return out


# ---------------------------------------------------------------- one case

def case_metrics(result: RunResult, expect: dict | None, kb: KnowledgeBase | None = None,
                 sources: Sequence[str] | None = None, calls: Sequence[dict] | None = None,
                 ranked: Sequence[dict] | None = None) -> dict:
    """Metrics for one run. `expect` holds the case's gold fields (eval/synthetic_cases.yaml, eval/dev_gold.yaml).

    `kb` resolves cited ids outside the evidence pack and table rows; `sources` (enquiry text, title, chat facts)
    enables recomputing the deterministic checks on the final report; `calls` are the run's recorded LLM calls and
    `ranked` the clarify gate's full question ranking.
    """
    report = result.report
    refused = report is None
    out: dict = dict.fromkeys((*METRIC_KEYS, *GOLD_KEYS))
    out["latency_s"] = round(sum(result.manifest.timings.values()), 3)
    out["status"] = report.decision_status.value if report else None
    out["scope"] = result.scope.label.value
    out |= run_metrics(result.events, calls, result.verification.issues, result.verification.verdicts,
                       result.manifest.timings, ranked=ranked)
    pack_cards = {c.id: c for c in (result.pack.cards if result.pack else [])}
    cards = {**(kb.cards if kb is not None else {}), **pack_cards}

    if expect is not None:
        out["scope_ok"] = result.scope.label.value in _scopes(expect)
        out |= gold_metrics(report, expect, cards)
    if refused:
        if expect is not None:
            out["trap_handled"] = all(s in (ScopeLabel.OFF_TOPIC.value, ScopeLabel.UNSAFE.value)
                                      for s in _scopes(expect))
        return out

    out["schema_ok"] = _schema_ok(report)
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
    aliases = kb.lexicon.get("methods", {}) if kb is not None else {}
    out["direct_answer_consistent"] = not direct_answer_problems(_body(report), aliases)

    if expect is not None:
        status_ok = out["status"] in expect.get("status_any_of", [])
        premise_ok = not expect.get("premise_flag") or any(pc.verdict in FLAGGED for pc in report.premise_checks)
        out["trap_handled"] = status_ok and premise_ok
        if expect.get("screening"):
            out["screening_ok"] = any(r.role in (RecRole.SCREENING, RecRole.CONDITIONAL)
                                      for r in report.recommendations)
    return out


# ---------------------------------------------------------------- aggregation

def _mean(values: Iterable) -> float | None:
    nums = [float(v) for v in values if v is not None]
    return round(sum(nums) / len(nums), 3) if nums else None


def _round(ci) -> list[float] | None:
    return [round(ci[0], 3), round(ci[1], 3)] if ci else None


def aggregate(rows: Sequence[dict]) -> dict:
    """Mean of every metric over the rows where it applies (booleans count as 0/1), with bootstrap 95 % CIs over
    cases (`ci`), time percentiles, pooled judge verdict shares and mean calls per role and tokens per model."""
    out: dict = {"n": len(rows), "errors": sum(1 for r in rows if r.get("error"))}
    keys = [k for k in (*METRIC_KEYS, *GOLD_KEYS, *RUN_KEYS, "judge_score") if any(k in r for r in rows)]
    ci = {}
    for key in keys:
        values = [r.get(key) for r in rows]
        out[key] = _mean(values)
        if key not in NO_CI and out[key] is not None:
            ci[key] = _round(mean_ci(values))
    for key in TIME_KEYS:
        if key in keys:
            out[f"{key}_p50"] = _round_or_none(percentile([r.get(key) for r in rows], 50))
            out[f"{key}_p90"] = _round_or_none(percentile([r.get(key) for r in rows], 90))
    judged = [r for r in rows if any(k in r for k in VERDICT_KEYS)]
    if judged:
        total = sum(int(r.get(k) or 0) for r in judged for k in VERDICT_KEYS)
        out["judge_verdicts"] = total
        for key in VERDICT_KEYS:
            hits = sum(int(r.get(key) or 0) for r in judged)
            out[f"{key}_share"] = round(hits / total, 3) if total else None
            pairs = [(int(r.get(key) or 0), sum(int(r.get(k) or 0) for k in VERDICT_KEYS)) for r in judged]
            ci[f"{key}_share"] = _round(pooled_share_ci(pairs)) if total else None
    roles: dict[str, list[int]] = {}
    with_calls = [r for r in rows if isinstance(r.get("calls_by_role"), dict)]
    for r in with_calls:
        for role, n in r["calls_by_role"].items():
            roles.setdefault(role, []).append(n)
    if with_calls:
        out["calls_by_role"] = {role: round(sum(ns) / len(with_calls), 2) for role, ns in sorted(roles.items())}
        models: dict[str, dict[str, float]] = {}
        for r in with_calls:
            for model, t in (r.get("tokens_by_model") or {}).items():
                acc = models.setdefault(model, {"in": 0.0, "out": 0.0, "cached": 0.0})
                for k in acc:
                    acc[k] += float(t.get(k) or 0)
        out["tokens_by_model"] = {m: {k: round(v / len(with_calls), 1) for k, v in t.items()}
                                  for m, t in sorted(models.items())}
        sections: dict[str, list[int]] = {}
        for r in with_calls:
            for section, n in (r.get("writer_tokens_by_section") or {}).items():
                sections.setdefault(section, []).append(n)
        if sections:
            out["writer_tokens_by_section"] = {s: round(sum(ns) / len(ns), 1) for s, ns in sorted(sections.items())}
    out["invented_numbers_total"] = sum(int(r.get("invented_numbers") or 0) for r in rows)
    out["ci"] = ci
    return out


def _round_or_none(value: float | None) -> float | None:
    return round(value, 3) if value is not None else None


def by_trap(rows: Sequence[dict]) -> dict[str, dict]:
    """Per trap category: cases, trap handling and status agreement (with CIs)."""
    out: dict[str, dict] = {}
    for trap in sorted({r.get("trap") for r in rows if r.get("trap")}):
        mine = [r for r in rows if r.get("trap") == trap]
        out[trap] = {"n": len(mine)}
        for key in ("trap_handled", "status_agreement", "method_agreement", "premise_agreement", "cite_recall"):
            values = [r.get(key) for r in mine]
            out[trap][key] = _mean(values)
            if out[trap][key] is not None:
                out[trap].setdefault("ci", {})[key] = _round(mean_ci(values))
    return out

