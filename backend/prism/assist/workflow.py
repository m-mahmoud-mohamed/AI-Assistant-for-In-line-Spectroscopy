"""The assessment workflow (docs/ASSISTANT_ARCHITECTURE.md §B.5): prepare → answer → write.

    prepare(enquiry)       scope guard, extraction (1 LLM call), normalise, rules and scoring, clarify gate, skeleton
                           → `engine_ready`
    answer(prepared, ...)  apply one confirmed fact, re-run the engine, the gate and the skeleton (no LLM, under 0.3 s)
    answer_text(...)       "Other...": the scientist's own words mapped to an allowed value (at most 1 small call)
    write(prepared)        evidence, three parallel writers, layered verification, sentence patches, assemble

`Pipeline.run` (prism/orchestrator.py) is `prepare` followed by `write`: the batch entry point used by the CLI,
`make answers`, the evaluation and the API.
"""
from __future__ import annotations

import copy
import hashlib
import logging
import re
import subprocess
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field, replace
from datetime import UTC, datetime
from pathlib import Path

from prism.assist.clarify import apply_confirmed, load_ontology, map_text, rank_questions, to_ask
from prism.assist.patch import patch_body
from prism.assist.sections import (
    SECTION_PATHS,
    SECTIONS,
    Skeleton,
    build_skeleton,
    ensure_afs,
    ensure_plan,
    merge,
    slice_issues,
    slice_pack,
    with_application_candidates,
)
from prism.cases import load_dev_cases, load_worked_examples
from prism.kb.loader import KnowledgeBase
from prism.llm.prompts import render
from prism.rules.engine import evaluate, evaluate_quick
from prism.schemas import (
    AssessmentReport,
    DecisionStatus,
    Enquiry,
    EvidencePack,
    Issue,
    ReportBody,
    RequirementsSheet,
    RuleFindings,
    RunManifest,
    ScopeDecision,
    ScopeLabel,
    VerificationReport,
    WebReport,
    WebSourceRecord,
    iter_segments,
)
from prism.stages.checks import CheckContext, NumberGuard, compliance, run_checks
from prism.stages.draft import write_sections
from prism.stages.extract import extract
from prism.stages.normalise import normalise_sheet
from prism.stages.render import build_report, to_markdown
from prism.stages.retrieve import Retriever
from prism.stages.scope import guard as scope_guard
from prism.stages.scope import refusal_text
from prism.stages.verify import gate_issues, quote_overlap_issues, verify
from prism.stages.web import build_queries, run_web_stage

log = logging.getLogger(__name__)

EVENT_TYPES = ("stage_started", "stage_completed", "rule_fired", "evidence_selected", "issue_found", "repaired",
               "run_completed", "run_refused", "web_source", "engine_ready", "section_ready")
SHOWN_CANDIDATES, SHOWN_BLOCKED = 12, 4
WEB_BUDGET_S = 10.0                # the web search may delay the writers by at most this long, from when it started
NOT_IN_TIME = "not checked in time"


@dataclass
class PipelineFlags:
    rules: bool = True
    verify: bool = True
    repair: bool = True                # patch failing sentences (stage `patch`)
    deep: bool = False
    web: bool = False                  # opt-in: search the web and add verified external cards
    retrieval: str = "hybrid"          # hybrid | bm25


@dataclass
class RunResult:
    report: AssessmentReport | None
    markdown: str
    manifest: RunManifest
    events: list[dict]
    scope: ScopeDecision
    sheet: RequirementsSheet | None = None
    findings: RuleFindings | None = None
    pack: EvidencePack | None = None
    verification: VerificationReport = field(default_factory=VerificationReport)
    web: WebReport | None = None
    revision: dict = field(default_factory=dict)


def _git_commit() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], check=False, capture_output=True,
                              text=True, timeout=5).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _texts(body: ReportBody) -> dict[str, str]:
    return {path: s.text for path, s in iter_segments(body)}


def carried_judge_issues(issues: list[Issue], judged: ReportBody, final: ReportBody) -> list[Issue]:
    """Judge verdicts that still apply: their path exists in the final body with the text the judge saw
    (the judge is not called again after patching)."""
    before, after = _texts(judged), _texts(final)
    return [i for i in issues if i.check_id == "C-SUPPORT" and i.message.startswith(("unsupported", "partial"))
            and i.path in after and after[i.path] == before.get(i.path)]


class RunState:
    """Events, stage timings and the thread-safe emit of one run (writers finish on worker threads)."""

    def __init__(self, run_id: str, emit: Callable[[dict], None] | None, started: str | None = None):
        self.run_id, self._emit, self.started = run_id, emit, started or _now()
        self.events: list[dict] = []
        self.timings: dict[str, float] = {}
        self._lock = threading.RLock()

    def emit(self, type_: str, stage: str, **payload) -> None:
        with self._lock:
            event = {"type": type_, "run_id": self.run_id, "seq": len(self.events), "ts": time.time(),
                     "stage": stage, "payload": payload}
            self.events.append(event)
            if self._emit:
                self._emit(event)

    @contextmanager
    def stage(self, name: str) -> Iterator[None]:
        self.emit("stage_started", name)
        t0 = time.monotonic()
        yield
        self.timings[name] = round(time.monotonic() - t0, 3)
        self.emit("stage_completed", name, seconds=self.timings[name])

    def fork(self) -> RunState:
        """A copy that continues this run's events and timings (a second `write` on the same Prepared)."""
        other = RunState(self.run_id, self._emit, self.started)
        other.events, other.timings = list(self.events), dict(self.timings)
        return other


@dataclass
class Prepared:
    """Result of the cheap first half: the engine's view of the enquiry, before any report text exists."""
    run_id: str
    enquiry: Enquiry
    scope: ScopeDecision
    sheet: RequirementsSheet | None            # includes confirmed facts applied; None when the scope guard refused
    findings: RuleFindings | None              # status, candidates, findings, question_seeds
    questions: list                            # ClarifyQuestions to ask now: the top decision-changing ones (≤ 3)
    confirmed: dict[str, str]                  # slot -> value confirmed in conversation
    refused: bool
    chat_facts: list[str] = field(default_factory=list)
    base_sheet: RequirementsSheet | None = None      # extracted and normalised, before confirmed facts
    skeleton: Skeleton | None = None
    refusal: str = ""
    meta: dict = field(default_factory=dict)         # extraction model and prompt hash
    state: RunState | None = None
    preferences: list[str] = field(default_factory=list)
    ranked: list = field(default_factory=list)       # every ClarifyQuestion of the gate, best first (the report's)
    deferred: list[str] = field(default_factory=list)  # slots answered "not known yet": open, but not asked again

    previous_report: AssessmentReport | None = None
    revised_sections: tuple[str, ...] = SECTIONS
    revision_trigger: str = ""
    change_summary: str = ""
    revision_findings: list[str] = field(default_factory=list)   # the new facts and instructions behind a revision
    previous_verdicts: list = field(default_factory=list)   # claim verdicts of the report being revised
    web_task: WebTask | None = None                # a web search started ahead of the run (else `write` starts it)

    def preview(self) -> dict:
        """The verdict preview (`engine_ready` payload): status, candidates, questions, spectral methods."""
        if self.refused or self.findings is None or self.skeleton is None:
            return {"status": "REFUSED", "candidates": [], "questions": [], "spectral_methods": []}
        return engine_payload(self.findings, self.skeleton, self.questions)


def engine_payload(findings: RuleFindings, skeleton: Skeleton, questions) -> dict:
    """The `engine_ready` event: verdict preview, candidates, questions and the methods that get a spectral range."""
    shown = [c for c in findings.candidates if not c.blocked][:SHOWN_CANDIDATES] + [
        c for c in findings.candidates if c.blocked][:SHOWN_BLOCKED]
    return {"status": findings.status.value,
            "candidates": [{"method": c.method, "technique": c.technique, "score": round(c.score, 2),
                            "blocked": c.blocked, "stream_id": c.stream_id, "reasons": c.reasons} for c in shown],
            "questions": [q.model_dump(mode="json") for q in questions],
            "spectral_methods": skeleton.recommended_methods()}


class WebTask:
    """The web stage started in the background as soon as the engine result is known. Its events are kept and replayed
    into the run that collects it; a result that is not ready within the budget is dropped."""

    def __init__(self, work: Callable[[Callable[..., None]], tuple[list, WebReport]], queries: list[str]):
        self.queries, self.started = queries, time.monotonic()
        self.events: list[tuple[str, dict]] = []
        self.cards: list = []
        self.report: WebReport | None = None
        self.done = threading.Event()
        self._work = work
        threading.Thread(target=self._run, daemon=True, name="web-search").start()

    def _run(self) -> None:
        def record(type_: str, stage: str, **payload) -> None:
            self.events.append((type_, payload))

        try:
            self.cards, self.report = self._work(record)
        except Exception as exc:  # noqa: BLE001 - web evidence is optional: the run goes on without it
            log.warning("web stage failed: %s", exc)
            self.cards, self.report = [], WebReport(enabled=True, queries=self.queries)
            record("web_source", "web", url="", title="", status="ERROR", domain="", card_id=None,
                   reason=f"{type(exc).__name__}: {exc}")
        finally:
            self.done.set()

    def collect(self, budget_s: float) -> tuple[list, WebReport, list[tuple[str, dict]]]:
        """(cards, report, events) when the search finished within `budget_s` of its start, else nothing but a note."""
        if self.done.wait(max(0.0, budget_s - (time.monotonic() - self.started))):
            return self.cards, self.report or WebReport(enabled=True), list(self.events)
        note = {"url": "", "title": "Web search", "status": "SKIPPED", "domain": "", "card_id": None,
                "reason": NOT_IN_TIME}
        report = WebReport(enabled=True, queries=self.queries, sources=[
            WebSourceRecord(title="Web search", url="", reason=NOT_IN_TIME)])
        return [], report, [("web_source", note)]


class Workflow:
    web_budget_s = WEB_BUDGET_S

    def __init__(self, gateway, kb: KnowledgeBase, flags: PipelineFlags | None = None,
                 emit: Callable[[dict], None] | None = None, web=None, materials: Path = Path("materials")):
        self.gateway, self.kb, self.flags, self.emit = gateway, kb, flags or PipelineFlags(), emit
        self.web = web                 # prism.web.WebService; built on first use when the web flag is on
        if self.flags.retrieval not in ("hybrid", "bm25"):
            raise ValueError(f"unknown retrieval mode {self.flags.retrieval!r}")
        self.materials = Path(materials)
        self.ontology = load_ontology(kb.root)
        self._examples: tuple[dict[str, str], list[str]] | None = None
        self.retriever = Retriever(kb, gateway if self.flags.retrieval == "hybrid" else None)

    # ------------------------------------------------------------ helpers

    @property
    def exemplars(self) -> dict[str, str]:
        return self._materials()[0]

    @property
    def in_examples(self) -> list[str]:
        return self._materials()[1]

    def _materials(self) -> tuple[dict[str, str], list[str]]:
        if self._examples is None:
            self._examples = (load_worked_examples(self.materials),
                              [c.text for c in load_dev_cases(self.materials)])
        return self._examples

    def _profile(self) -> str:
        return getattr(getattr(self.gateway, "profile", None), "name", "fake")

    def _run_id(self, enquiry: Enquiry, chat_facts: list[str], confirmed: dict[str, str],
                preferences: list[str]) -> str:
        # Deterministic: same input, KB, profile, chat state, expert preferences, confirmed facts and flags give the
        # same run id. (The web flag and confirmed facts join the key only when set, so older ids stay the same.)
        flags = {k: v for k, v in asdict(self.flags).items() if k != "web" or v}
        extra = f"|{sorted(confirmed.items())}" if confirmed else ""
        key = (f"{enquiry.case_id}|{enquiry.sha256}|{self.kb.version}|{self._profile()}|{chat_facts}|"
               f"{preferences}|{sorted(flags.items())}{extra}")
        return hashlib.sha256(key.encode()).hexdigest()[:12]

    def _engine(self, sheet: RequirementsSheet, quick: bool = False) -> RuleFindings:
        """Rules, scoring and status. With the rules flag off (ablation) the candidates stay but nothing blocks.
        `quick` skips the question seeds (same findings, candidates and status): the gate's what-if."""
        raw = (evaluate_quick if quick else evaluate)(sheet, self.kb)
        if self.flags.rules:
            return with_application_candidates(raw, sheet, self.kb)
        return RuleFindings(status=DecisionStatus.PROVISIONAL, candidates=[
            c.model_copy(update={"blocked": False, "reasons": []}) for c in raw.candidates])

    def _gate(self, sheet: RequirementsSheet, findings: RuleFindings, deferred=()) -> tuple[list, list, Skeleton]:
        """The clarify gate: every ranked question, those to ask now, and the skeleton whose report questions they
        lead."""
        ranked = rank_questions(sheet, findings, self.kb, lambda s: self._engine(s, quick=True), self.ontology)
        skeleton = build_skeleton(sheet, findings, self.kb, ranked, self.ontology.covers)
        return ranked, to_ask(ranked, deferred), skeleton

    def _manifest(self, state: RunState, enquiry: Enquiry, models: dict, hashes: dict,
                  output_sha: str | None = None) -> RunManifest:
        return RunManifest(run_id=state.run_id, case_id=enquiry.case_id, input_sha256=enquiry.sha256,
                           kb_version=self.kb.version, profile=self._profile(), model_ids=models,
                           prompt_hashes=hashes, git_commit=_git_commit(), started_at=state.started,
                           finished_at=_now(), timings=dict(state.timings),
                           flags={k: str(v) for k, v in asdict(self.flags).items()}, output_sha256=output_sha)

    # ------------------------------------------------------------ prepare

    def prepare(self, enquiry: Enquiry, chat_facts=(), confirmed: dict[str, str] | None = None,
                preferences=()) -> Prepared:
        """Scope guard, extraction (one LLM call), engine and skeleton. Emits `engine_ready` before any writer."""
        chat_facts, confirmed, preferences = list(chat_facts), dict(confirmed or {}), list(preferences)
        state = RunState(self._run_id(enquiry, chat_facts, confirmed, preferences), self.emit)
        with state.stage("scope"):
            scope = scope_guard(f"{enquiry.title}. {enquiry.text}", self.kb, self.gateway, self.in_examples)
        if scope.label in (ScopeLabel.OFF_TOPIC, ScopeLabel.UNSAFE):
            state.emit("run_refused", "scope", label=scope.label.value, reason=scope.reason)
            return Prepared(state.run_id, enquiry, scope, None, None, [], confirmed, True, chat_facts,
                            refusal=refusal_text(scope), state=state, preferences=preferences)
        with state.stage("extract"):
            sheet, xmeta = extract(enquiry, self.gateway, chat_facts)
        with state.stage("normalise"):
            base = normalise_sheet(sheet, " ".join([enquiry.text, *chat_facts]), self.kb)
        with state.stage("rules"):
            sheet = apply_confirmed(base, confirmed)
            findings = self._engine(sheet)
            for f in findings.findings:
                state.emit("rule_fired", "rules", rule_id=f.rule_id, severity=f.severity.value, message=f.message)
            ranked, questions, skeleton = self._gate(sheet, findings)
        state.emit("engine_ready", "rules", **engine_payload(findings, skeleton, questions))
        return Prepared(state.run_id, enquiry, scope, sheet, findings, questions, confirmed, False, chat_facts,
                        base_sheet=base, skeleton=skeleton, meta=xmeta, state=state, preferences=preferences,
                        ranked=ranked)

    def _start_web(self, sheet: RequirementsSheet, findings: RuleFindings) -> WebTask | None:
        """Start the web search now (it runs while the questions are asked and the evidence is retrieved)."""
        if not self.flags.web:
            return None
        try:
            if self.web is None:
                from prism.web import WebService
                self.web = WebService.for_gateway(self.gateway)
        except Exception as exc:  # noqa: BLE001 - web evidence is optional
            log.warning("web service unavailable: %s", exc)
            return None
        web, gateway = self.web, self.gateway
        return WebTask(lambda emit: run_web_stage(sheet, findings, gateway, web, emit),
                       build_queries(sheet, findings))

    # ------------------------------------------------------------ answer

    def answer(self, prepared: Prepared, slot: str, value: str) -> Prepared:
        """Apply one confirmed fact and re-run the engine, the gate and the skeleton. No LLM call. 'unknown' ('not
        known yet') leaves the slot open (or reopens it) and defers it: it stays in the report, it is not asked
        again. An invalid slot or value raises ValueError."""
        if prepared.refused or prepared.base_sheet is None or prepared.sheet is None:
            raise ValueError("a refused enquiry has nothing to answer")
        if self.ontology.spec(slot) is not None:
            value = self.ontology.check(prepared.sheet, slot, value)
        value = str(value).strip() or "unknown"
        confirmed, deferred = dict(prepared.confirmed), [d for d in prepared.deferred if d != slot]
        if value == "unknown":
            confirmed.pop(slot, None)
            deferred.append(slot)
        else:
            confirmed[slot] = value
        sheet = apply_confirmed(prepared.base_sheet, confirmed)      # raises ValueError for an invalid slot or value
        findings = self._engine(sheet)
        ranked, questions, skeleton = self._gate(sheet, findings, deferred)
        run_id = self._run_id(prepared.enquiry, prepared.chat_facts, confirmed, prepared.preferences)
        return replace(prepared, run_id=run_id, sheet=sheet, findings=findings, confirmed=confirmed,
                       deferred=deferred, questions=questions, ranked=ranked, skeleton=skeleton)

    def answer_text(self, prepared: Prepared, slot: str, text: str) -> Prepared:
        """"Other...": the scientist's own words mapped to an allowed value (an exact value or label needs no model,
        anything else one small classifier call), then applied like a click. Words that settle nothing count as
        'not known yet'."""
        if prepared.refused or prepared.sheet is None:
            raise ValueError("a refused enquiry has nothing to answer")
        return self.answer(prepared, slot, map_text(self.gateway, self.ontology, prepared.sheet, slot, text))

    # ------------------------------------------------------------ write

    def write(self, prepared: Prepared, preferences=(),
              on_partial: Callable[[str, ReportBody], None] | None = None) -> RunResult:
        """Evidence, three parallel writers, verification, sentence patches, assemble. `on_partial(section, body)`
        receives the merged body each time a section is ready, just before its `section_ready` event."""
        if prepared.refused:
            return RunResult(None, prepared.refusal,
                             self._manifest(prepared.state, prepared.enquiry, {}, {},
                                            hashlib.sha256(prepared.refusal.encode()).hexdigest()),
                             list(prepared.state.events), prepared.scope)
        preferences = list(preferences) or list(prepared.preferences)
        state = prepared.state.fork() if prepared.state is not None else RunState(prepared.run_id, self.emit)
        state.run_id = prepared.run_id
        if preferences != prepared.preferences:           # preferences given at write time are part of the identity
            state.run_id = self._run_id(prepared.enquiry, prepared.chat_facts, prepared.confirmed, preferences)
        enquiry, sheet, findings, skeleton = prepared.enquiry, prepared.sheet, prepared.findings, prepared.skeleton
        flags, gateway = self.flags, self.gateway
        writer_role = "writer_deep" if flags.deep else "writer"
        judge_role = "judge_deep" if flags.deep else "judge"
        patch_role = "patcher"
        confirmed_texts = [f"{v}" for v in prepared.confirmed.values()]
        sources = [enquiry.text, enquiry.title, *prepared.chat_facts, *confirmed_texts]
        computed = [f"{r.nominal_range} {r.units}" for r in skeleton.ranges]
        numbers_guard = NumberGuard(sources, computed)

        # The web search starts now, beside the evidence retrieval, and the writers wait for it at most its budget.
        task = (prepared.web_task or self._start_web(sheet, findings)) if flags.web else None
        with state.stage("retrieve"):
            pack = self.retriever.pack(sheet, findings)
            state.emit("evidence_selected", "retrieve", ids=sorted(pack.ids()))
        web_report, kb = None, self.kb
        if flags.web:
            with state.stage("web"):
                if task is None:
                    cards, web_report = [], WebReport(enabled=True)
                    state.emit("web_source", "web", url="", title="", status="ERROR", domain="", card_id=None,
                               reason="web search is not available")
                else:
                    cards, web_report, events = task.collect(self.web_budget_s)
                    for type_, payload in events:
                        state.emit(type_, "web", **payload)
                if cards:      # verified web cards live in this run's knowledge view only, never in kb/
                    kb = replace(self.kb, cards={**self.kb.cards, **{c.id: c for c in cards}})
                    pack = EvidencePack(cards=[*pack.cards, *cards],
                                        reasons={**pack.reasons, **{c.id: "web (verified)" for c in cards}})
        cards_by_id = {**kb.cards, **{c.id: c for c in pack.cards}}

        def checks(body: ReportBody) -> list[Issue]:
            return run_checks(CheckContext(body, sheet, findings, pack, kb, list(sources), computed))

        emitted: set[str] = set()

        def ready(section: str, partial: ReportBody) -> None:
            if section not in emitted:
                emitted.add(section)
                if on_partial is not None:
                    on_partial(section, partial)
                state.emit("section_ready", "write", section=section, paths=list(SECTION_PATHS[section]))

        def owned(issue: Issue, section: str) -> bool:
            return bool(issue.path) and re.split(r"[.\[]", issue.path, maxsplit=1)[0] in SECTION_PATHS[section]

        previous = prepared.previous_report
        selected = prepared.revised_sections if previous else SECTIONS
        kept = [f for section in SECTIONS if section not in selected for f in SECTION_PATHS[section]]

        def carry(body: ReportBody) -> ReportBody:
            """A revision keeps the verified content of the sections it does not rewrite."""
            for name in kept:
                setattr(body, name, copy.deepcopy(getattr(previous, name)))
            return body

        slices = slice_pack(pack, skeleton, findings, kb)
        with state.stage("write"):
            seen: dict = {}
            if previous is not None:      # the sections a revision keeps are on show at once
                carried = carry(merge(skeleton, kb, pack, {}, slices, numbers_guard).body)
                for section in SECTIONS:
                    if section not in selected:
                        ready(section, carried)

            def on_section(section: str, draft) -> None:
                # A section is announced as soon as its own sentences pass the deterministic checks.
                seen[section] = draft
                partial = merge(skeleton, kb, pack, dict(seen), slices, numbers_guard)
                partial.body = carry(partial.body)
                bad = [i for i in checks(partial.body) if i.severity == "error" and owned(i, section)]
                if not bad:
                    ready(section, partial.body)

            drafts, wmeta = write_sections(enquiry, sheet, findings, skeleton, slices, gateway, self.exemplars,
                                           prepared.chat_facts, prepared.confirmed, preferences, writer_role,
                                           on_section, sections=selected)
            merged = merge(skeleton, kb, pack, drafts, slices, numbers_guard)
            body = carry(merged.body)
        slice_warnings = [Issue(check_id="C-IDS", path=p, message=m, severity="warning")
                          for p, m in slice_issues(merged)]
        slice_warnings += [Issue(check_id="W-WRITER", path=section, severity="warning",
                                 message=f"writer {section} failed ({error}); its prose was filled by code")
                           for section, error in wmeta["failed"].items()]
        for i in slice_warnings:
            state.emit("issue_found", "write", check_id=i.check_id, path=i.path, message=i.message,
                       severity=i.severity)

        verification = VerificationReport(issues=slice_warnings)
        judge_model, patch_model = "", ""
        if flags.verify:
            with state.stage("verify"):
                verification = verify(body, sheet, findings, pack, kb, sources, gateway,
                                      sheet.client_question, role=judge_role, computed_texts=computed,
                                      only_fields={p for section in selected for p in SECTION_PATHS[section]}
                                      if previous else None)
                judge_model = verification.judge_model
                for i in verification.issues:
                    state.emit("issue_found", "verify", check_id=i.check_id, path=i.path, message=i.message,
                               severity=i.severity)
                verification.issues += slice_warnings
                if previous is not None:      # the kept sections' claims were judged when they were written
                    verification.verdicts += [v for v in prepared.previous_verdicts
                                              if re.split(r"[.\[]", v.path, maxsplit=1)[0] in kept]
            failing = [i for i in verification.issues if i.severity == "error" or i.message.startswith("partial")]
            if flags.repair and failing:
                with state.stage("patch"):
                    judged, judged_issues = body, verification.issues

                    def recheck(b: ReportBody, changed: set[str]) -> list[Issue]:
                        # Deterministic re-check only; the judge's verdicts carry over where the text is unchanged.
                        return (checks(b) + gate_issues(b, sources) + quote_overlap_issues(b, cards_by_id, changed)
                                + carried_judge_issues(judged_issues, judged, b))

                    outcome = patch_body(body, verification.issues, cards_by_id, gateway, recheck, role=patch_role)
                    patch_model = outcome.model
                    body = carry(ensure_plan(ensure_afs(outcome.body, skeleton, kb, pack), skeleton))
                    verification = VerificationReport(issues=recheck(body, set()) + slice_warnings,
                                                      verdicts=verification.verdicts, judge_model=judge_model)
                    state.emit("repaired", "patch", remaining=[i.check_id for i in verification.issues
                                                                if i.severity == "error"],
                               rounds=outcome.rounds, actions=outcome.actions, stripped=outcome.stripped)
        for section in SECTIONS:
            ready(section, body)

        models = {"extractor": prepared.meta.get("model", ""), writer_role: wmeta["model"]}
        if judge_model:
            models[judge_role] = judge_model
        if patch_model:
            models[patch_role] = patch_model
        hashes = {"extract": prepared.meta.get("prompt_hash", ""), "write": wmeta["prompt_hash"],
                  "judge": render("judge.j2", claims=[], examples=[])[1],
                  "patch": render("patch.j2", sentences=[], round=1)[1]}
        with state.stage("render"):
            meta = {"run_id": state.run_id, "created_at": state.started, "profile": self._profile(),
                    "model_ids": models, "prompt_hashes": hashes}
            report = build_report(body, enquiry, sheet, findings, kb, meta, compliance(verification))
            if previous:
                cited = {cid for _, seg in iter_segments(report) for cid in seg.evidence_ids}
                have = {s.id for s in report.sources}
                report.sources += [s.model_copy(deep=True) for s in previous.sources if s.id in cited - have]
            revision = {"original_enquiry": enquiry.text, "trigger": prepared.revision_trigger,
                        "changed_sections": [*selected, "requirements"] if previous else [],
                        "summary": prepared.change_summary, "follow_up_findings": list(prepared.revision_findings)}
            markdown = to_markdown(report)
        out_sha = hashlib.sha256(markdown.encode()).hexdigest()
        state.emit("run_completed", "render", status=report.decision_status.value)
        return RunResult(report, markdown, self._manifest(state, enquiry, models, hashes, out_sha), state.events,
                         prepared.scope, sheet, findings, pack, verification, web_report, revision)

