"""The PRISM pipeline: scope → extract → normalise → rules → retrieve → draft → verify → repair → render."""
from __future__ import annotations

import hashlib
import subprocess
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from prism.cases import load_dev_cases, load_worked_examples
from prism.kb.loader import KnowledgeBase
from prism.rules.engine import evaluate
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
    iter_segments,
)
from prism.stages.checks import CheckContext, compliance, run_checks
from prism.stages.draft import draft
from prism.stages.extract import extract
from prism.stages.normalise import normalise_sheet
from prism.stages.render import build_report, to_markdown
from prism.stages.repair import repair, strip_failing
from prism.stages.retrieve import Retriever
from prism.stages.scope import guard, refusal_text
from prism.stages.verify import verify

EVENT_TYPES = ("stage_started", "stage_completed", "rule_fired", "evidence_selected", "issue_found", "repaired",
               "run_completed", "run_refused")


@dataclass
class PipelineFlags:
    rules: bool = True
    verify: bool = True
    repair: bool = True
    deep: bool = False
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


def _git_commit() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], check=False, capture_output=True,
                              text=True, timeout=5).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def _texts(body: ReportBody) -> dict[str, str]:
    return {path: s.text for path, s in iter_segments(body)} | {"": body.model_dump_json()}


def carried_critic_issues(issues: list[Issue], judged: ReportBody, final: ReportBody) -> list[Issue]:
    """Critic C-SUPPORT / P-SCOPE issues that still apply: their path exists in the final body with the text
    the critic judged (the critic is not called again after repair)."""
    before, after = _texts(judged), _texts(final)
    return [i for i in issues if i.check_id in ("C-SUPPORT", "P-SCOPE")
            and i.path in after and after[i.path] == before.get(i.path)]


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


class Pipeline:
    def __init__(self, gateway, kb: KnowledgeBase, materials: Path = Path("materials"),
                 flags: PipelineFlags | None = None, emit: Callable[[dict], None] | None = None):
        self.gateway, self.kb, self.flags, self.emit = gateway, kb, flags or PipelineFlags(), emit
        if self.flags.retrieval not in ("hybrid", "bm25"):
            raise ValueError(f"unknown retrieval mode {self.flags.retrieval!r}")
        self.exemplars = load_worked_examples(Path(materials))
        self.in_examples = [c.text for c in load_dev_cases(Path(materials))]
        self.retriever = Retriever(kb, gateway if self.flags.retrieval == "hybrid" else None)

    def _profile(self) -> str:
        return getattr(getattr(self.gateway, "profile", None), "name", "fake")

    def run(self, enquiry: Enquiry, chat_facts=(), preferences=()) -> RunResult:
        chat_facts, preferences = list(chat_facts), list(preferences)
        # Deterministic: same input, KB, profile, chat state and flags give the same run_id.
        key = (f"{enquiry.case_id}|{enquiry.sha256}|{self.kb.version}|{self._profile()}|{chat_facts}|"
               f"{preferences}|{sorted(asdict(self.flags).items())}")
        run_id = hashlib.sha256(key.encode()).hexdigest()[:12]
        events: list[dict] = []
        timings: dict[str, float] = {}
        started = _now()

        def emit(type_: str, stage: str, **payload) -> None:
            event = {"type": type_, "run_id": run_id, "seq": len(events), "ts": time.time(), "stage": stage,
                     "payload": payload}
            events.append(event)
            if self.emit:
                self.emit(event)

        @contextmanager
        def stage(name: str) -> Iterator[None]:
            emit("stage_started", name)
            t0 = time.monotonic()
            yield
            timings[name] = round(time.monotonic() - t0, 3)
            emit("stage_completed", name, seconds=timings[name])

        def manifest(models: dict, hashes: dict, output_sha: str | None = None) -> RunManifest:
            return RunManifest(run_id=run_id, case_id=enquiry.case_id, input_sha256=enquiry.sha256,
                               kb_version=self.kb.version, profile=self._profile(), model_ids=models,
                               prompt_hashes=hashes, git_commit=_git_commit(), started_at=started,
                               finished_at=_now(), timings=timings,
                               flags={k: str(v) for k, v in asdict(self.flags).items()}, output_sha256=output_sha)

        with stage("scope"):
            scope = guard(f"{enquiry.title}. {enquiry.text}", self.kb, self.gateway, self.in_examples)
        if scope.label in (ScopeLabel.OFF_TOPIC, ScopeLabel.UNSAFE):
            markdown = refusal_text(scope)
            emit("run_refused", "scope", label=scope.label.value, reason=scope.reason)
            return RunResult(None, markdown, manifest({}, {}, hashlib.sha256(markdown.encode()).hexdigest()),
                             events, scope)

        sources = [enquiry.text, enquiry.title, *chat_facts]
        with stage("extract"):
            sheet, xmeta = extract(enquiry, self.gateway, chat_facts)
        with stage("normalise"):
            sheet = normalise_sheet(sheet, " ".join([enquiry.text, *chat_facts]), self.kb)
        with stage("rules"):
            findings = evaluate(sheet, self.kb) if self.flags.rules else RuleFindings(status=DecisionStatus.PROVISIONAL)
            for f in findings.findings:
                emit("rule_fired", "rules", rule_id=f.rule_id, severity=f.severity.value, message=f.message)
        with stage("retrieve"):
            pack = self.retriever.pack(sheet, findings)
            emit("evidence_selected", "retrieve", ids=sorted(pack.ids()))
        role = "generator_deep" if self.flags.deep else "generator"
        with stage("draft"):
            body, dmeta = draft(enquiry, sheet, findings, pack, self.gateway, self.exemplars, chat_facts,
                                preferences, role)
        verification = VerificationReport()
        critic_role = "critic_deep" if self.flags.deep else "critic"
        if self.flags.verify:
            with stage("verify"):
                verification = verify(body, sheet, findings, pack, self.kb, sources, self.gateway,
                                      sheet.client_question, role=critic_role)
                for i in verification.issues:
                    emit("issue_found", "verify", check_id=i.check_id, path=i.path, message=i.message,
                         severity=i.severity)
            if self.flags.repair and not verification.passed:
                with stage("repair"):
                    judged = body

                    def recheck(b: ReportBody) -> list[Issue]:
                        # Deterministic re-check only; the critic's verdicts carry over where text is unchanged.
                        return (run_checks(CheckContext(b, sheet, findings, pack, self.kb, list(sources)))
                                + carried_critic_issues(verification.issues, judged, b))

                    body = repair(body, verification.issues, pack, self.gateway, role)
                    body = strip_failing(body, recheck(body))
                    verification = VerificationReport(issues=recheck(body), verdicts=verification.verdicts)
                    emit("repaired", "repair", remaining=[i.check_id for i in verification.issues
                                                          if i.severity == "error"])
        models = {"extractor": xmeta["model"], role: dmeta["model"]}
        hashes = {"extract": xmeta["prompt_hash"], "draft": dmeta["prompt_hash"]}
        with stage("render"):
            meta = {"run_id": run_id, "created_at": started, "profile": self._profile(), "model_ids": models,
                    "prompt_hashes": hashes}
            report = build_report(body, enquiry, sheet, findings, self.kb, meta, compliance(verification))
            markdown = to_markdown(report)
        out_sha = hashlib.sha256(markdown.encode()).hexdigest()
        emit("run_completed", "render", status=report.decision_status.value)
        return RunResult(report, markdown, manifest(models, hashes, out_sha), events, scope, sheet, findings, pack,
                         verification)
