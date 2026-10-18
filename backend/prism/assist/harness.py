"""The assistant harness (docs/ASSISTANT_ARCHITECTURE.md §B.3–B.5): what one scientist message does.

    fast path   a new enquiry (a session without a report): plan → assess.prepare → verdict → up to two question cards
                (each answer applied by the engine, no model call; a verdict after each card) → the report run (the
                existing run stream) → ONE agent call that sums the report up → suggested next steps → turn_completed
    agent loop  everything else (follow-ups, explanations, comparisons, new client facts, clicked next steps): role
                `agent` with function calling over the interaction tools (ask_user, update_plan, request_approval,
                suggest_next) and the domain tools (assess.*, engine.explain, kb.*, calc.*, report.*, record_fact,
                draft_email, web.* behind an approval). At most 8 tool steps; Stop is checked between steps;
                re-assessments, deep mode and the web wait for an approval card.
    verifier    every final answer: cited card ids must exist and come from a tool or the report; every number must
                appear in the enquiry, the client or confirmed facts, the report, a card or a tool result; a URL only
                when verified. Failing sentences are dropped and the answer says so.

The engine decides; the agent explains, asks and runs tools. Answers to question cards are confirmed facts (provenance
"confirmed in conversation"), kept per session in the store and applied to every later report of the session.
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field, replace

from prism.assist.clarify import ASK_LIMIT, change, effects, load_ontology, outcome, to_ask
from prism.assist.tools import SessionView, Tool, domain_tools, obj
from prism.assist.turns import Stopped, Turn, Turns
from prism.assist.workflow import Prepared, RunResult, RunState, Workflow
from prism.chat import (
    GUARD_NOTE,
    email_draft,
    guard_text,
    handle_message,
    mentioned_ids,
    report_summary,
    report_texts,
    result_ids,
    web_tools,
)
from prism.connectors.registry import agent_tools as connector_tools
from prism.kb.loader import KnowledgeBase
from prism.llm.cache import ReplayMiss
from prism.llm.gateway import LLMUnavailable
from prism.llm.prompts import render
from prism.schemas import (
    AssessmentReport,
    ClarifyOption,
    ClarifyQuestion,
    DecisionStatus,
    Enquiry,
    RecRole,
    RuleFindings,
    ScopeDecision,
    ScopeLabel,
)
from prism.stages.extract import grounded
from prism.stages.scope import refusal_text, signal_scores
from prism.stages.scope import suggestions as scope_suggestions
from prism.store import Store

log = logging.getLogger(__name__)

MAX_STEPS = 8                        # tool steps per scientist message
MAX_ROUNDS = 2                       # question cards in the fast path
HISTORY_MESSAGES, HISTORY_CHARS = 6, 1200
RESULT_CHARS = 12000                 # a tool result sent back to the model
STREAM_WORDS, STREAM_PAUSE_S = 6, 0.03
RUN_POLL_S = 0.2
THIN_SOURCES = 3                     # fewer AFS sources than this, or weak evidence for the lead method: offer the web
PLAN = (("understand", "Understand the enquiry"), ("clarify", "Clarify open points"),
        ("write", "Write the assessment"), ("verify", "Verify every sentence"))
ACTIONS = ("assess.write", "assess.write_deep", "web.search", "draft_email", "compare", "ask")
ACTION_LABELS = {"assess.write": "Re-assess now", "assess.write_deep": "Re-run deep",
                 "web.search": "Search literature", "draft_email": "Draft client e-mail"}
APPROVALS = {      # action: (card label, why, model calls it costs)
    "assess.write": ("Re-assess with the new information?",
                     ("A new report version: three section writers, the support judge and, if needed, a sentence "
                      "patch."), 5),
    "assess.write_deep": ("Re-run the assessment in deep mode?",
                          ("Deep mode writes and judges with the top-tier model, for hard or high-stakes cases. It "
                           "is slower and costs more."), 5),
    "web.search": ("Search scholarly literature for verified external sources?",
                   ("The AFS sources say little about this application. External sources are added only when "
                    "their quote is verified on the page."), 3),
}
DECLINED = {"assess.write": "Skipped the re-assessment. The facts are saved and the current report stays as it is.",
            "assess.write_deep": "Skipped the deep re-run. The current report stays as it is.",
            "web.search": "Skipped the literature search. The report stays based on the AFS sources."}
STATUS_WORDS = {DecisionStatus.PROVISIONAL: "Provisional",
                DecisionStatus.INSUFFICIENT_INFORMATION: "Insufficient information",
                DecisionStatus.OUTSIDE_SUPPORTED_SCOPE: "Outside the supported scope"}
LIMIT_NOTE = "Tool limit reached. Answer now, using only the tool results above; do not call more tools."
LIMIT_FALLBACK = ("I reached the limit of tool steps for one message before I could answer. Ask a narrower question, "
                  "or ask me to continue.")
EMPTY_ANSWER = ("I could not ground an answer in the report or the evidence cards. Ask a narrower question, or put it "
                "to the client.")
NO_MODEL = "No model is configured for the assistant (role `agent`)."
_ID = r"(?:S\d{2}|TABLE|EXT)-[\w.-]+"                                   # card ids: S01-p10-…, TABLE-…, EXT-…
_MARKER = re.compile(rf"\[({_ID})\]")
_MARKERS = re.compile(rf"\[({_ID}(?:\s*[,;]\s*{_ID})+)\]")         # [A, B]: one marker per id


# ---------------------------------------------------------------- the run a turn starts

@dataclass
class RunHandle:
    """A report run started from a Prepared: its progress is the normal run stream; `done` is set when it ends."""
    run_id: str
    version: int
    done: threading.Event = field(default_factory=threading.Event)
    result: RunResult | None = None
    error: str | None = None
    check: Callable[[], None] = lambda: None


# start_run(session id, workflow, prepared, observe, announce): `announce(handle)` runs before the run's thread starts,
# so the turn's `report` event comes before any event the run's observer reacts to.
StartRun = Callable[[str, Workflow, Prepared, Callable[[dict], None] | None, Callable[[RunHandle], None] | None],
                    RunHandle]


def bind(prepared: Prepared, emit: Callable[[dict], None]) -> Prepared:
    """The same Prepared, writing its run events to `emit` (prepare ran before the run existed). The prepare stages'
    events and timings are kept, so the manifest and the event sequence numbers continue from them."""
    state = RunState(prepared.run_id, emit)
    if prepared.state is not None:
        state.events, state.timings = list(prepared.state.events), dict(prepared.state.timings)
    return replace(prepared, state=state)


def run_seed(prepared: Prepared) -> list[dict]:
    """The opening events of a run that starts from a Prepared: the prepare stages as they ran, with the engine's
    result as it stands now (answers given since then change the findings and the verdict)."""
    if prepared.state is None:
        return []
    out = []
    for e in prepared.state.events:
        if e["type"] in ("rule_fired", "engine_ready"):
            continue
        if e["type"] == "stage_completed" and e["stage"] == "rules" and prepared.findings is not None:
            out += [{"type": "rule_fired", "ts": e["ts"], "stage": "rules",
                     "payload": {"rule_id": f.rule_id, "severity": f.severity.value, "message": f.message}}
                    for f in prepared.findings.findings]
            out.append(e)
            out.append({"type": "engine_ready", "ts": e["ts"], "stage": "rules", "payload": prepared.preview()})
            continue
        out.append(e)
    return [{k: v for k, v in e.items() if k not in ("seq", "run_id")} for e in out]


def rebase(wf: Workflow, prepared: Prepared) -> Prepared:
    """The same engine state under another workflow: deep or web flags are part of the deterministic run id."""
    return replace(prepared, run_id=wf._run_id(prepared.enquiry, prepared.chat_facts, prepared.confirmed,
                                                 prepared.preferences))


def with_deferred(prepared: Prepared, deferred: list[str]) -> Prepared:
    """Slots answered 'not known yet' earlier in the session stay out of the question cards."""
    if not deferred or prepared.refused:
        return prepared
    return replace(prepared, deferred=list(deferred), questions=to_ask(prepared.ranked, deferred))


# ---------------------------------------------------------------- small views of the engine's state

def _candidate(c) -> str:
    return f"{c.method} {c.technique} ({round(c.score, 2)}{', blocked' if c.blocked else ''})"


def compact(p: Prepared | None) -> dict:
    """The engine's verdict in a few words (for tool results and the system prompt)."""
    if p is None or p.findings is None:
        return {"status": "REFUSED" if p is not None and p.refused else "NONE"}
    open_ = [c for c in p.findings.candidates if not c.blocked][:4]
    blocked = [c for c in p.findings.candidates if c.blocked][:3]
    return {"status": p.findings.status.value, "candidates": [_candidate(c) for c in open_],
            "blocked": [_candidate(c) for c in blocked], "open_questions": [q.slot for q in p.questions]}


def prepare_summary(p: Prepared) -> str:
    if p.refused or p.findings is None:
        return "outside PRISM's scope"
    parts = [STATUS_WORDS.get(p.findings.status, p.findings.status.value).lower()]
    lead = next((c for c in p.findings.candidates if not c.blocked), None)
    if lead is not None:
        parts.append(f"{lead.method} {lead.technique} first")
    if p.questions:
        parts.append(f"{len(p.questions)} open point{'s' if len(p.questions) != 1 else ''}")
    return " · ".join(parts)


def _label_of(q: ClarifyQuestion, value: str) -> str:
    return next((o.label for o in q.options if o.value == value), value)


def apply_answers(wf: Workflow, p: Prepared, questions: list[ClarifyQuestion],
                  answers: dict) -> tuple[Prepared, list[str], list[str]]:
    """A question card's answers applied by the engine: {value} and {values} as confirmed facts, {unknown} deferred,
    {other} mapped to an allowed value (one classifier call). Returns (prepared, applied, notes on answers that could
    not be used); an answer that does not fit is skipped, never guessed."""
    applied, notes = [], []
    for q in questions:
        a = answers.get(q.id)
        a = a if isinstance(a, dict) else ({"value": str(a)} if a not in (None, "") else {"unknown": True})
        said = ""
        try:
            if a.get("unknown"):
                p = wf.answer(p, q.slot, "unknown")
                continue
            if str(a.get("other") or "").strip():
                said = str(a["other"]).strip()
                p = wf.answer_text(p, q.slot, said)
                value = p.confirmed.get(q.slot)
                if value is None:
                    notes.append(f"“{said}” did not settle “{q.text}”, so it stays open for the client.")
                    continue
            else:
                value = a.get("value") if a.get("value") is not None else next(iter(a.get("values") or []), None)
                if value is None:
                    p = wf.answer(p, q.slot, "unknown")
                    continue
                said = str(value)
                p = wf.answer(p, q.slot, said)
                value = p.confirmed.get(q.slot, said)
            applied.append(f"{q.text} → {_label_of(q, value)}")
        except ValueError:
            notes.append(f"I could not use “{said}” as an answer to “{q.text}”: it is not one of its options.")
        except (LLMUnavailable, ReplayMiss):
            notes.append(f"I could not read “{said}” for “{q.text}” (the model is not available); it stays open.")
    return p, applied, notes


def slot_help(kb: KnowledgeBase) -> str:
    """The slots a fact can be confirmed for, with their allowed values (from the slot ontology)."""
    onto = load_ontology(kb.root)
    lines = []
    for spec in onto.specs:
        slot = "streams.<stream id>." + spec.name if spec.per_stream else spec.slot
        if spec.slot == "term:*":
            lines.append("term:<term>: the meaning of an ambiguous term (its alternatives)")
            continue
        values = " | ".join(spec.allowed) + (" | or the variable's own name" if spec.free_text else "")
        lines.append(f"{slot}: {values}")
    return "; ".join(lines)


# ---------------------------------------------------------------- the answer verifier

def verify_answer(text: str, kb: KnowledgeBase, allowed: set[str], sources: list[str],
                  urls=()) -> tuple[str, int]:
    """Drop citation markers of cards that do not exist or that no tool returned, then every sentence whose numbers,
    wording or URLs fail the report's checks (line by line, so Markdown lists keep their shape). Returns
    (text, sentences removed)."""
    allowed = {cid for cid in allowed if cid in kb.cards or cid.startswith("EXT-")}
    text = _MARKERS.sub(lambda m: " ".join(f"[{i}]" for i in re.split(r"\s*[,;]\s*", m.group(1))), text or "")
    text = _MARKER.sub(lambda m: m.group(0) if m.group(1) in allowed else "", text)
    text = re.sub(r"[ \t]+([.,;:!?])", r"\1", text)
    cited = [cid for cid in allowed if f"[{cid}]" in text]
    out, removed = [], 0
    for line in text.strip().split("\n"):
        if not line.strip():
            if out and out[-1]:
                out.append("")
            continue
        indent = line[:len(line) - len(line.lstrip())]
        kept, n = guard_text(line, kb, cited, sources, urls)
        removed += n
        if kept.strip():
            out.append(indent + kept)
    return "\n".join(out).strip(), removed


def citations(text: str, kb: KnowledgeBase, labels: dict[str, str]) -> dict[str, str]:
    """{card id: display label} of the cards the message cites."""
    ids = list(dict.fromkeys([*_MARKER.findall(text), *mentioned_ids(text, kb)]))
    out = {}
    for cid in ids:
        if cid in labels:
            out[cid] = labels[cid]
        elif cid in kb.cards:
            out[cid] = kb.cards[cid].citation()
    return out


def code_summary(report: AssessmentReport) -> str:
    """The summary when no model is available: verified report sentences only, with their card ids."""
    recs = [r for r in report.recommendations if r.role != RecRole.NOT_RECOMMENDED]
    status = STATUS_WORDS.get(report.decision_status, report.decision_status.value)
    lines = [f"**{status}: {' + '.join(recs[0].methods)} {recs[0].technique}.**" if recs else f"**{status}.**"]
    supported = [seg for rec in recs[:1] for seg in rec.rationale if seg.evidence_ids]
    for seg in [*report.direct_answer.text[:1], *supported[:1]]:
        lines.append(seg.text + "".join(f" [{i}]" for i in seg.evidence_ids))
    n = len(report.clarification_questions)
    if n:
        lines.append(f"{n} open question{'s' if n != 1 else ''} for the client {'are' if n != 1 else 'is'} in the "
                     "Questions tab.")
    return " ".join(lines)


def digest(report: AssessmentReport, version: int) -> dict:
    """The report, as the summary call reads it: verified sentences with their card ids."""
    def say(segments) -> list[str]:
        return [s.text + "".join(f" [{i}]" for i in s.evidence_ids) for s in segments]
    return {"version": version, "status": report.decision_status.value, "verdict": report.direct_answer.verdict.value,
            "direct_answer": say(report.direct_answer.text),
            "recommendations": [{"title": f"{' + '.join(r.methods)} {r.technique}", "role": r.role.value,
                                 "rationale": say(r.rationale[:2])} for r in report.recommendations],
            "questions": [q.question for q in sorted(report.clarification_questions, key=lambda q: q.priority)][:4],
            "source_ids": [s.id for s in report.sources]}


def thin_evidence(report: AssessmentReport) -> bool:
    """Little AFS evidence for this application: few AFS sources, or weak evidence behind the lead method."""
    afs = [s for s in report.sources if not s.url]
    lead = [r for r in report.recommendations if r.role in (RecRole.PRIMARY, RecRole.SCREENING)]
    return len(afs) < THIN_SOURCES or any(r.evidence_strength == "Weak" for r in lead)


# ---------------------------------------------------------------- per-turn state

@dataclass
class Context:
    """The session as a turn starts: its enquiry, latest report, facts and recent conversation."""
    session: dict
    enquiry: Enquiry | None
    report: AssessmentReport | None
    report_key: str | None                 # the latest report's deterministic run id (manifest)
    findings: RuleFindings | None
    runs: dict[int, str]                   # version -> run id
    chat_facts: list[str]
    preferences: list[str]
    confirmed: dict[str, str]
    deferred: list[str]
    deep: bool
    web: bool
    history: list[dict]

    @property
    def sid(self) -> str:
        return self.session["id"]


@dataclass
class AgentState:
    ctx: Context
    view: SessionView
    message: str = ""
    approved: set[str] = field(default_factory=set)
    suggestions: list[dict] | None = None
    calls: list[dict] = field(default_factory=list)
    workflow: Workflow | None = None
    prepared: Prepared | None = None
    wrote: RunHandle | None = None
    changed: bool = False                  # the turn saved new client facts
    declined: set[str] = field(default_factory=set)


class Plan:
    """The plan card of the fast path: a fixed checklist whose statuses move as the work goes."""

    def __init__(self, turn: Turn, steps=PLAN):
        self.turn = turn
        self.steps = [{"id": i, "label": label, "status": "pending"} for i, label in steps]
        self._lock = threading.Lock()

    def set(self, detail: dict[str, str] | None = None, **status: str) -> None:
        with self._lock:
            for s in self.steps:
                s["status"] = status.get(s["id"], s["status"])
                if detail and s["id"] in detail:
                    s["detail"] = detail[s["id"]]
            self.turn.emit("plan", steps=[dict(s) for s in self.steps])

    def status(self, step: str) -> str:
        with self._lock:
            return next((s["status"] for s in self.steps if s["id"] == step), "")

    def finish(self) -> None:
        self.set(**{s["id"]: "done" for s in self.steps if s["status"] != "skipped"})


def _call_id() -> str:
    return uuid.uuid4().hex[:10]


def _same_text(a: str, b: str) -> bool:
    return " ".join(a.split()).casefold() == " ".join(b.split()).casefold()


# ---------------------------------------------------------------- the harness

class Harness:
    def __init__(self, store: Store, kb: KnowledgeBase, turns: Turns, workflow_for: Callable[[bool, bool], Workflow],
                 start_run: StartRun, enquiry_for: Callable[[dict], Enquiry | None], gateway=None, web=None,
                 retriever: Callable[[], object] | None = None):
        self.store, self.kb, self.turns, self.gateway, self.web = store, kb, turns, gateway, web
        self.workflow_for, self.start_run, self.enquiry_for = workflow_for, start_run, enquiry_for
        self._retriever = retriever
        self._memory: dict[str, Prepared] = {}      # the engine's latest view per session (rebuilt when missing)
        self._lock = threading.Lock()

    def retriever(self):
        if self._retriever is None:
            from prism.stages.retrieve import Retriever
            built = Retriever(self.kb, self.gateway)
            self._retriever = lambda: built
        return self._retriever()

    # ------------------------------------------------------------ entry points

    def start(self, session: dict, text: str | None = None, action: str | None = None, payload=None) -> str:
        """`POST /sessions/{id}/turns`: start a turn and return its id at once (the work streams as events)."""
        input_ = {"action": action, "payload": payload} if action else {"text": text}
        turn = self.turns.start(session["id"], "action" if action else "text", input_,
                                lambda t: self._turn(t, session, text, action, payload))
        return turn.id

    def message(self, session: dict, text: str, start_run: Callable[[], str], web=None) -> dict | None:
        """`POST /sessions/{id}/messages`: the original chat routing, run as a turn and waited for. Returns its
        response (None when a newer turn of the session interrupted it); a failure is raised again here."""
        turn = self.turns.start(session["id"], "message", {"text": text},
                                lambda t: self._legacy(t, session, text, start_run, web))
        turn.done.wait()
        if turn.error is not None:
            raise turn.error
        return turn.result

    # ------------------------------------------------------------ routing

    def _turn(self, turn: Turn, session: dict, text: str | None, action: str | None, payload) -> None:
        turn.check()
        ctx = self._context(session)
        if action == "ask":
            action, text = None, (payload if isinstance(payload, str) else str((payload or {}).get("text", "")))
            if not text.strip():
                return turn.complete("There was no question to ask.")
        if action:
            return self._action(turn, ctx, action, payload)
        text = (text or "").strip()
        new = re.match(r"^(?:new|another|different)\s+(?:enquiry|inquiry|assessment|client enquiry)\b", text,
                       re.IGNORECASE)
        if ctx.report is None or new:
            if ctx.enquiry is None or not _same_text(text, ctx.enquiry.text):
                self.store.begin_enquiry(ctx.sid, text)
                with self._lock:
                    self._memory.pop(ctx.sid, None)
                ctx = self._context(session)
            return self._assess(turn, ctx)
        decision = self._off_topic(text)
        if decision is not None:
            message = refusal_text(decision)
            self._say(turn, message)
            self._remember_messages(ctx, (text, "question"), message, kind="refused")
            return turn.complete(message)
        return self._agent(turn, ctx, text, said=text)

    def _off_topic(self, text: str) -> ScopeDecision | None:
        """The scope guard of follow-ups, code only: inside an assessed session the agent's own rules handle doubtful
        messages; clear off-topic or unsafe signals end the turn without a model call."""
        ins, off, unsafe = signal_scores(text, self.kb.lexicon)
        if unsafe:
            return ScopeDecision(label=ScopeLabel.UNSAFE, suggestions=scope_suggestions(),
                                 reason="The message asks PRISM to bypass its rules or reveal internal configuration.")
        if off and not ins:
            return ScopeDecision(label=ScopeLabel.OFF_TOPIC, suggestions=scope_suggestions(),
                                 reason="The message is not about a process or material measurement.")
        return None

    def _context(self, session: dict) -> Context:
        sid = session["id"]
        fresh = self.store.get_session(sid) or {**session, "messages": [], "reports": []}
        enquiry = self.enquiry_for(fresh)
        runs = {r["version"]: r["run_id"] for r in fresh["reports"]}
        report = findings = key = None
        deep = web = False
        if runs:
            stored = self.store.report(runs[max(runs)]) or {}
            if stored.get("report") and (enquiry is None or
                                          stored["report"].get("input_sha256") == enquiry.sha256):
                report = AssessmentReport.model_validate(stored["report"])
            if report is not None and stored.get("findings"):
                findings = RuleFindings.model_validate(stored["findings"])
            manifest = stored.get("manifest") or {}
            flags, key = manifest.get("flags") or {}, manifest.get("run_id")
            deep, web = str(flags.get("deep")) == "True", str(flags.get("web")) == "True"
        facts, prefs = self.store.chat_state(sid)
        confirmed, deferred = self.store.assist_state(sid)
        start = max((i for i, m in enumerate(fresh["messages"]) if m["kind"] == "enquiry"), default=-1)
        history = fresh["messages"][start + 1:][-HISTORY_MESSAGES:]
        if report is None:
            deep = web = False
        return Context(fresh, enquiry, report, key, findings, runs, facts, prefs, confirmed, deferred,
                       deep, web, history)

    # ------------------------------------------------------------ session memory

    def _remember(self, ctx: Context, p: Prepared) -> None:
        with self._lock:
            self._memory[ctx.sid] = p
        if not p.refused:
            self.store.set_assist_state(ctx.sid, p.confirmed, p.deferred)
            ctx.confirmed, ctx.deferred = dict(p.confirmed), list(p.deferred)

    def _recall(self, ctx: Context, fresh_facts: bool = False) -> Prepared | None:
        with self._lock:
            p = self._memory.get(ctx.sid)
        if p is None or p.refused or p.confirmed != ctx.confirmed:
            return None
        if fresh_facts and (p.chat_facts != ctx.chat_facts or p.preferences != ctx.preferences):
            return None
        return p

    def _prepared(self, turn: Turn, ctx: Context, wf: Workflow, fresh_facts: bool = False) -> Prepared | None:
        """The session's engine state: from memory, else `prepare` again (its extraction call is normally a cache
        hit: same enquiry, same facts, same model)."""
        p = self._recall(ctx, fresh_facts)
        if p is not None or ctx.enquiry is None:
            return p
        with self._tool(turn, "assess.prepare", "Reading the enquiry and the client facts") as row:
            p = with_deferred(wf.prepare(ctx.enquiry, ctx.chat_facts, ctx.confirmed, ctx.preferences), ctx.deferred)
            row["summary"] = prepare_summary(p)
        self._remember(ctx, p)
        return p

    def _remember_messages(self, ctx: Context, user: tuple[str, str] | None, assistant: str | None,
                           run_id: str | None = None, kind: str = "answer") -> None:
        """The turn in the session's message history (shown when the session is reopened)."""
        if user is not None and user[0]:
            self.store.add_message(ctx.sid, "user", user[1], user[0], run_id)
            run_id = None
        if assistant:
            self.store.add_message(ctx.sid, "assistant", kind, assistant, run_id)

    # ------------------------------------------------------------ helpers that emit

    @contextmanager
    def _tool(self, turn: Turn, tool: str, label: str) -> Iterator[dict]:
        """A tool activity row around code the harness runs itself."""
        turn.check()
        call_id, row, t0 = _call_id(), {"summary": ""}, time.monotonic()
        turn.emit("tool_started", call_id=call_id, tool=tool, label=label)
        try:
            yield row
            turn.check()
        except Stopped:
            raise
        except Exception as exc:
            turn.emit("tool_finished", call_id=call_id, tool=tool, summary=f"{type(exc).__name__}: {exc}"[:200],
                      ms=int((time.monotonic() - t0) * 1000), ok=False)
            raise
        turn.emit("tool_finished", call_id=call_id, tool=tool, summary=row["summary"],
                  ms=int((time.monotonic() - t0) * 1000), ok=True)

    def _say(self, turn: Turn, text: str) -> None:
        """Stream a verified message in small pieces (it is checked before the first piece goes out)."""
        words = re.findall(r"\S+\s*", text)
        for i in range(0, len(words), STREAM_WORDS):
            turn.check()
            turn.emit("message_delta", text="".join(words[i:i + STREAM_WORDS]))
            if STREAM_PAUSE_S:
                time.sleep(STREAM_PAUSE_S)

    def _approve(self, turn: Turn, st: AgentState, action: str, why: str | None = None,
                 label: str | None = None) -> bool:
        """An approval card for a costly or external action (once per action and turn)."""
        if action in st.approved:
            return True
        if action in st.declined:
            return False
        default_label, default_why, cost = APPROVALS.get(action, (label or action, why or "", 0))
        aid = f"ap-{_call_id()}"
        reply = turn.wait_for("approval", aid, {"approval_id": aid, "action": action, "label": label or default_label,
                                                "why": why or default_why, "cost_calls": cost})
        if reply is True:
            st.approved.add(action)
        else:
            st.declined.add(action)
        turn.check()
        return reply is True

    # ------------------------------------------------------------ the fast path

    def _assess(self, turn: Turn, ctx: Context) -> None:
        plan = Plan(turn)
        plan.set(understand="active")
        wf = self.workflow_for(False, False)
        with self._tool(turn, "assess.prepare", "Reading the enquiry") as row:
            p = with_deferred(wf.prepare(ctx.enquiry, ctx.chat_facts, ctx.confirmed, ctx.preferences), ctx.deferred)
            row["summary"] = prepare_summary(p)
        turn.check()
        if p.refused:
            plan.set({"understand": "Outside PRISM's scope"}, understand="done", clarify="skipped", write="skipped",
                     verify="skipped")
            self._say(turn, p.refusal)
            self._remember_messages(ctx, None, p.refusal, kind="refused")
            return turn.complete(p.refusal)
        self._remember(ctx, p)
        turn.emit("verdict", **p.preview())
        p, answered, notes = self._clarify(turn, ctx, wf, p, plan)
        handle = self._write(turn, ctx, wf, p, plan)
        self._after_report(turn, ctx, handle, plan, answered=answered, notes=notes)

    def _clarify(self, turn: Turn, ctx: Context, wf: Workflow, p: Prepared,
                 plan: Plan) -> tuple[Prepared, list[str], list[str]]:
        """Up to two question cards: the second only for slots the first did not show (answers can open new ones)."""
        asked = turn.asked
        answered, notes = [], []
        for round_ in range(turn.question_rounds, MAX_ROUNDS):
            new = [q for q in p.questions if q.slot not in asked][:ASK_LIMIT]
            if not new:
                break
            asked |= {q.slot for q in new}
            n = len(new)
            title = (f"{n} questions that change the recommendation" if n > 1 else
                     "1 question that changes the recommendation") if round_ == 0 else (
                f"{n} more questions that change the recommendation" if n > 1 else
                "One more question that changes the recommendation")
            plan.set({"clarify": title[0].upper() + title[1:]}, understand="done", clarify="active")
            qid = f"q-{_call_id()}"
            turn.question_rounds += 1
            reply = turn.wait_for("question", qid, {"question_id": qid, "title": title,
                                                    "questions": [q.model_dump(mode="json") for q in new]})
            with self._tool(turn, "assess.answer", "Applying your answers") as row:
                p, applied, skipped = apply_answers(wf, p, new, (reply or {}).get("answers") or {})
                row["summary"] = (f"{len(applied)} applied, {n - len(applied)} left open · "
                                  f"{STATUS_WORDS[p.findings.status].lower()}")
            answered += applied
            notes += skipped
            self._remember(ctx, p)
            turn.emit("verdict", **p.preview())
        detail = (f"{len(answered)} answered, {len(asked) - len(answered)} left for the client" if asked else
                  "Nothing changes the recommendation")
        plan.set({"clarify": detail}, understand="done", clarify="done" if asked else "skipped", write="active")
        return p, answered, notes

    def _write(self, turn: Turn, ctx: Context, wf: Workflow, p: Prepared, plan: Plan | None = None) -> RunHandle:
        """Start the report run (the run stream shows its stages) and wait for it, checking Stop."""
        turn.check()

        def observe(event: dict) -> None:
            if plan is not None and event.get("type") == "stage_started" and event.get("stage") in ("verify", "patch") \
                    and plan.status("verify") == "pending":
                plan.set(write="done", verify="active")

        def announce(handle: RunHandle) -> None:
            handle.check = turn.check
            turn.emit("report", run_id=handle.run_id, version=handle.version)

        handle = self.start_run(ctx.sid, wf, p, observe, announce)
        while not handle.done.wait(RUN_POLL_S):
            turn.check()
        turn.check()
        return handle

    def _after_report(self, turn: Turn, ctx: Context, handle: RunHandle, plan: Plan | None, answered=(), notes=(),
                      said: str | None = None) -> None:
        """The report is written: one agent call sums it up, then the next steps."""
        turn.check()
        result = handle.result
        if handle.error or result is None or result.report is None:
            error = handle.error or "the run produced no report"
            self._remember_messages(ctx, (said, "question") if said else None, None)
            return turn.fail(f"The report run failed: {error}")
        if plan is not None:
            plan.finish()
        message, labels = self._summarise(ctx, result.report, handle.version, list(answered), list(notes))
        self._say(turn, message)
        turn.emit("suggestions", options=self._suggestions(result.report, result))
        self._remember_messages(ctx, (said, "question") if said else None, message, handle.run_id)
        turn.complete(message, citations(message, self.kb, labels))

    def _summarise(self, ctx: Context, report: AssessmentReport, version: int, answered: list[str],
                   notes: list[str]) -> tuple[str, dict[str, str]]:
        labels = {s.id: s.citation for s in report.sources}
        text = ""
        if self.gateway is not None:
            system, _ = render("assistant_system.j2", mode="summary", digest=digest(report, version),
                               answered=answered, notes=notes)
            try:
                text = self.gateway.complete("agent", [{"role": "system", "content": system},
                                                       {"role": "user", "content": "Sum up the assessment for me."}]).text
            except (LLMUnavailable, ReplayMiss) as exc:      # the report stands; code sums it up instead
                log.warning("summary call failed: %s", exc)
        sources = [*(ctx.enquiry.text, ctx.enquiry.title), *ctx.chat_facts, *ctx.confirmed.values(),
                   *report_texts(report)] if ctx.enquiry else report_texts(report)
        text, _ = verify_answer(text, self.kb, set(labels), sources)
        if not text:
            text = code_summary(report)
        if notes:
            text = text + "\n\n" + " ".join(notes)
        text, _ = verify_answer(text, self.kb, set(labels), sources)
        return text, labels

    def _suggestions(self, report: AssessmentReport, result: RunResult | None) -> list[dict]:
        flags = result.manifest.flags if result is not None else {}
        out = []
        out.append({"label": "Draft client e-mail", "action": "draft_email"})
        methods = list(dict.fromkeys(m for r in report.recommendations if r.role != RecRole.NOT_RECOMMENDED
                                     for m in r.methods))
        if len(methods) >= 2:
            out.append({"label": f"Compare {methods[0]} vs {methods[1]}", "action": "compare",
                        "payload": {"a": methods[0], "b": methods[1]}})
        if flags.get("deep") != "True":
            out.append({"label": "Re-run deep", "action": "assess.write_deep"})
        if self.web is not None and flags.get("web") != "True" and thin_evidence(report):
            out.append({"label": "Search literature", "action": "web.search"})
        return out

    # ------------------------------------------------------------ clicked next steps

    def _action(self, turn: Turn, ctx: Context, action: str, payload) -> None:
        said = ACTION_LABELS.get(action, action)
        if action == "draft_email":
            if ctx.report is None:
                message = "There is no report yet to draft an e-mail from."
                self._say(turn, message)
                return turn.complete(message)
            if self.gateway is None:
                return turn.fail(NO_MODEL)
            with self._tool(turn, "draft_email", "Drafting the client e-mail") as row:
                text = email_draft(ctx.report, self.gateway)
                n = len(ctx.report.clarification_questions)
                row["summary"] = f"{n} question{'s' if n != 1 else ''} for the client"
            text, removed = verify_answer(text, self.kb, {s.id for s in ctx.report.sources},
                                           self._view(ctx, "").sources)
            text = (text + "\n\n" + GUARD_NOTE).strip() if removed else text or EMPTY_ANSWER
            self._say(turn, text)
            self._remember_messages(ctx, (said, "question"), text)
            return turn.complete(text, citations(text, self.kb, {s.id: s.citation for s in ctx.report.sources}))
        if action == "compare":
            a, b = self._pair(ctx, payload)
            said = f"Compare {a} vs {b}"
            instruction = (f"Compare {a} and {b} for this enquiry: which fits better here and why. Use the engine's "
                           f"scores (engine_explain for each) and the evidence cards; keep it short and cite the "
                           f"cards. Do not change the engine's decision.")
            return self._agent(turn, ctx, instruction, said=said)
        st = AgentState(ctx, self._view(ctx, ""))
        if not self._approve(turn, st, action):
            message = DECLINED[action]
            self._say(turn, message)
            self._remember_messages(ctx, (said, "question"), message)
            return turn.complete(message)
        if action == "web.search":
            if self.web is None:
                return turn.complete("Literature search is not configured for this server.")
            instruction = ("Search literature for this enquiry using web_search. Verify any quoted external claim "
                           "with web_verify and explain the evidence briefly. Do not re-write the report.")
            return self._agent(turn, ctx, instruction, said=said, approved=st.approved)
        deep, web = action == "assess.write_deep" or ctx.deep, action == "web.search" or ctx.web
        if deep and action != "assess.write_deep":
            deep = self._approve(turn, st, "assess.write_deep")
        if web:
            web = self._approve(turn, st, "web.search")
        plan = Plan(turn, PLAN[2:])
        plan.set(write="active")
        handle = self._rerun(turn, ctx, deep, web, plan)
        if handle is None:
            message = "There is no assessable enquiry in this session."
            self._say(turn, message)
            return turn.complete(message)
        self._after_report(turn, ctx, handle, plan, said=said)

    @staticmethod
    def _pair(ctx: Context, payload) -> tuple[str, str]:
        if isinstance(payload, dict) and payload.get("a") and payload.get("b"):
            return str(payload["a"]), str(payload["b"])
        if isinstance(payload, str) and " vs " in payload:
            a, b = payload.split(" vs ", 1)
            return a.strip(), b.strip()
        methods = list(dict.fromkeys(m for r in (ctx.report.recommendations if ctx.report else []) for m in r.methods))
        a, b = (methods + ["the primary method", "the comparison method"][len(methods):])[:2]
        return a, b

    def _rerun(self, turn: Turn, ctx: Context, deep: bool, web: bool, plan: Plan | None = None) -> RunHandle | None:
        """A new report version from the session's facts (new client facts are extracted again first)."""
        wf = self.workflow_for(deep, web)
        p = self._prepared(turn, ctx, wf, fresh_facts=True)
        if p is None or p.refused:
            return None
        p = rebase(wf, p)
        self._remember(ctx, p)
        handle = self._write(turn, ctx, wf, p, plan)
        if handle.result is not None and handle.result.report is not None:
            ctx.runs[handle.version] = handle.run_id
        return handle

    # ------------------------------------------------------------ the agent loop

    def _view(self, ctx: Context, message: str) -> SessionView:
        def report_at(version: int) -> AssessmentReport | None:
            stored = self.store.report(ctx.runs[version]) if version in ctx.runs else None
            return AssessmentReport.model_validate(stored["report"]) if stored and stored.get("report") else None

        sources = [message, *ctx.chat_facts, *ctx.confirmed.values(), *report_texts(ctx.report)]
        if ctx.enquiry is not None:
            sources += [ctx.enquiry.text, ctx.enquiry.title]
        return SessionView(ctx.report, ctx.findings, sorted(ctx.runs), report_at, sources)

    def _engine(self, turn: Turn, st: AgentState) -> tuple[Workflow, Prepared | None]:
        if st.workflow is None:
            st.workflow = self.workflow_for(st.ctx.deep, st.ctx.web)
        if st.prepared is None:
            st.prepared = self._prepared(turn, st.ctx, st.workflow)
        return st.workflow, st.prepared

    def _agent(self, turn: Turn, ctx: Context, text: str, said: str | None = None, approved=()) -> None:
        if self.gateway is None:
            return turn.fail(NO_MODEL)
        st = AgentState(ctx, self._view(ctx, text), message=text, prepared=self._recall(ctx), approved=set(approved))
        tools = self._tools(turn, st)
        by_wire, specs = {t.wire: t for t in tools}, [t.spec() for t in tools]
        msgs = [{"role": "system", "content": self._system(st)}, {"role": "user", "content": text}]
        steps, final = 0, None
        while final is None:
            turn.check()
            res = self.gateway.complete("agent", msgs, tools=specs)
            turn.check()
            if not res.tool_calls:
                final = res.text
                break
            msgs.append({"role": "assistant", "content": res.text or "",
                         "tool_calls": [c.to_message() for c in res.tool_calls]})
            for c in res.tool_calls:
                turn.check()
                if steps >= MAX_STEPS:
                    out = {"error": "tool limit reached; answer with what you have"}
                else:
                    steps += 1
                    out = self._call(turn, st, by_wire.get(c.name), c.name, c.arguments)
                    if turn.finished:
                        return
                msgs.append({"role": "tool", "tool_call_id": c.id,
                             "content": json.dumps(out, ensure_ascii=False, default=str)[:RESULT_CHARS]})
            if steps >= MAX_STEPS:
                turn.check()
                res = self.gateway.complete("agent", msgs + [{"role": "user", "content": LIMIT_NOTE}])
                final = res.text if res.text.strip() else LIMIT_FALLBACK
        self._finish(turn, st, final, said)

    def _call(self, turn: Turn, st: AgentState, tool: Tool | None, name: str, raw: str) -> dict:
        """One tool call: approval first where needed, a tool row around domain tools, errors back to the model."""
        turn.check()
        try:
            args = json.loads(raw or "{}")
        except (TypeError, ValueError):
            args = {}
        args = args if isinstance(args, dict) else {}
        if tool is None:
            return {"error": f"unknown tool {name!r}"}
        if tool.approval and not self._approve(turn, st, tool.approval):
            return {"declined": True, "note": "the scientist declined this step; do not try it again in this turn"}
        if tool.interaction:
            try:
                out = tool.fn(args)
                turn.check()
            except (Stopped, LLMUnavailable):
                raise
            except Exception as exc:  # noqa: BLE001 - a bad argument goes back to the model
                return {"error": f"{type(exc).__name__}: {exc}"}
            st.view.sources.append(json.dumps(out, ensure_ascii=False, default=str))     # e.g. the scientist's answers
            return out
        call_id, t0, ok = _call_id(), time.monotonic(), True
        try:
            label = tool.label(args)
        except Exception:  # noqa: BLE001 - a label never fails the call
            label = tool.name
        turn.emit("tool_started", call_id=call_id, tool=tool.name, label=label)
        try:
            out = tool.fn(args)
            turn.check()
            ok = not bool(out.get("error"))
        except (Stopped, LLMUnavailable):
            raise
        except Exception as exc:  # noqa: BLE001 - tool errors go back to the model, never crash the turn
            out, ok = {"error": f"{type(exc).__name__}: {exc}"}, False
        try:
            summary = tool.summary(out)
        except Exception:  # noqa: BLE001
            summary = ""
        turn.emit("tool_finished", call_id=call_id, tool=tool.name, summary=str(summary)[:200],
                  ms=int((time.monotonic() - t0) * 1000), ok=ok)
        st.calls.append({"name": tool.name, "arguments": args, "result": out})
        if tool.name != "web.search" and not out.get("error"):
            st.view.sources.append(json.dumps(out, ensure_ascii=False, default=str))
        return out

    def _system(self, st: AgentState) -> str:
        ctx, p = st.ctx, st.prepared
        report = report_summary(ctx.report)
        if report is not None:
            report["version"] = max(ctx.runs) if ctx.runs else 1
        verdict = None
        if p is not None and p.findings is not None and (ctx.report is None or p.run_id != ctx.report_key):
            v = compact(p)
            verdict = {"status": v["status"], "candidates": v["candidates"] + [f"{b}" for b in v["blocked"]]}
        open_questions = [{"slot": q.slot, "text": q.text, "options": [f"{o.value} = {o.label}" for o in q.options]}
                          for q in (p.ranked if p is not None else [])][:6]
        system, _ = render("assistant_system.j2", mode="agent", max_steps=MAX_STEPS, web=self.web is not None,
                           enquiry=ctx.enquiry.text if ctx.enquiry else None, facts=ctx.chat_facts,
                           confirmed=sorted(ctx.confirmed.items()), preferences=ctx.preferences, report=report,
                           versions=sorted(ctx.runs), verdict=verdict, open_questions=open_questions)
        if ctx.history:
            lines = [f"{'Scientist' if m['role'] == 'user' else 'You'}: {m['text'][:HISTORY_CHARS]}"
                     for m in ctx.history]
            system += "\nRECENT CONVERSATION (oldest first)\n" + "\n".join(lines) + "\n"
        return system

    def _finish(self, turn: Turn, st: AgentState, final: str, said: str | None) -> None:
        """Verify the final answer, stream it, offer next steps, end the turn."""
        report, ctx = st.view.report, st.ctx
        labels = {s.id: s.citation for s in report.sources} if report is not None else {}
        for c in st.calls:
            for card in (c["result"].get("cards") or []) if isinstance(c["result"], dict) else []:
                if isinstance(card, dict) and card.get("id"):
                    labels.setdefault(card["id"], card.get("citation", card["id"]))
            if isinstance(c["result"], dict) and c["result"].get("id") and c["result"].get("citation"):
                labels.setdefault(c["result"]["id"], c["result"]["citation"])
        allowed = {cid for c in st.calls for cid in result_ids(c["result"])} | set(labels)
        verified = [c["result"] for c in st.calls if c["name"] == "web.verify" and isinstance(c["result"], dict)
                    and c["result"].get("verified")]
        urls = [v["url"] for v in verified] + [s.url for s in (report.sources if report else [])
                                               if s.url and s.verification and s.verification.verified]
        text, removed = verify_answer(final, self.kb, allowed, [s for s in st.view.sources if s], urls)
        if removed:
            text = f"{text}\n\n{GUARD_NOTE}".strip()
        text = text or EMPTY_ANSWER
        self._say(turn, text)
        options = st.suggestions
        if options is None and st.wrote is not None and st.wrote.result is not None and st.wrote.result.report:
            options = self._suggestions(st.wrote.result.report, st.wrote.result)
        if options is None and st.changed and st.wrote is None:
            options = [{"label": "Re-assess now", "action": "assess.write"}]
        if options:
            turn.emit("suggestions", options=options)
        kind = "new_client_info" if st.changed else "question"
        self._remember_messages(ctx, (said, kind) if said else None, text, st.wrote.run_id if st.wrote else None)
        web_sources = [{k: v.get(k) for k in ("url", "doi", "domain", "domain_tier", "retrieved_at", "quote", "title")}
                       for v in verified if v.get("url") and v["url"] in text]
        turn.complete(text, citations(text, self.kb, labels), **({"web_sources": web_sources} if web_sources else {}))

    # ------------------------------------------------------------ the agent's tools

    def _tools(self, turn: Turn, st: AgentState) -> list[Tool]:
        tools = [*self._interaction_tools(turn, st), *self._assess_tools(turn, st),
                 *domain_tools(self.kb, self.retriever(), st.view)]
        if st.ctx.report is not None:
            tools.append(Tool("draft_email", "A short client e-mail that asks the report's open questions. One "
                              "model call. Show the e-mail as it is.", obj({}),
                              lambda a: {"text": email_draft(st.view.report or st.ctx.report, self.gateway)},
                              lambda a: "Drafting the client e-mail", lambda r: "drafted"))
        tools += connector_tools(st.ctx.sid)               # MCP servers the scientist enabled (prism/connectors)
        if self.web is not None:
            for spec in web_tools(self.web, st.message):
                name = "web.search" if spec.name == "web_search" else "web.verify"
                tools.append(Tool(name, spec.description, spec.parameters, spec.fn,
                                  (lambda a: f"Searching scholarly sources for “{a.get('query', '')}”")
                                  if name == "web.search" else (lambda a: "Verifying a quote on its source page"),
                                  (lambda r: r.get("error") or f"{len(r.get('results', []))} results (unverified)")
                                  if name == "web.search" else (lambda r: r.get("error") or r.get("status", "")),
                                  approval="web.search"))
        return tools

    def _interaction_tools(self, turn: Turn, st: AgentState) -> list[Tool]:
        def said(q: ClarifyQuestion, ans) -> str:
            ans = ans if isinstance(ans, dict) else {"unknown": True}
            if ans.get("unknown"):
                return "not known yet"
            if str(ans.get("other") or "").strip():
                return str(ans["other"]).strip()
            value = ans.get("value") if ans.get("value") is not None else next(iter(ans.get("values") or []), None)
            return _label_of(q, str(value)) if value is not None else "not known yet"

        def ask(a: dict) -> dict:
            if turn.question_rounds >= MAX_ROUNDS:
                return {"error": "question limit reached; use the known facts and leave unknowns for the client"}
            questions: list[ClarifyQuestion] = []
            p = None
            slots = [str(s) for s in a.get("slots") or []]
            if slots:
                _, p = self._engine(turn, st)
                ranked = {q.slot: q for q in (p.ranked if p is not None else [])}
                questions += [ranked[s] for s in slots if s in ranked]
            for i, q in enumerate(a.get("questions") or []):
                if not isinstance(q, dict):
                    continue
                opts = list(dict.fromkeys(str(o).strip() for o in q.get("options") or [] if str(o).strip()))[:5]
                if len(opts) >= 2 and str(q.get("text") or "").strip():
                    questions.append(ClarifyQuestion(
                        id=f"free-{i + 1}", slot="", text=str(q["text"]).strip(), why=str(q.get("why") or ""),
                        impact="RISK_ONLY", options=[ClarifyOption(value=o, label=o, effect="") for o in opts]))
            questions = [q for q in questions if (q.slot or q.text) not in turn.asked][:ASK_LIMIT]
            if not questions:
                return {"error": "no valid question: give slots listed under OPEN SLOTS, or questions with 2 to 5 "
                                 "options"}
            qid = f"q-{_call_id()}"
            turn.question_rounds += 1
            turn.asked.update(q.slot or q.text for q in questions)
            n = len(questions)
            title = str(a.get("title") or "").strip() or (f"{n} questions" if n > 1 else "1 question")
            reply = turn.wait_for("question", qid, {"question_id": qid, "title": title,
                                                    "questions": [q.model_dump(mode="json") for q in questions]})
            turn.check()
            answers = (reply or {}).get("answers") or {}
            out: dict = {"answers": {q.text: said(q, answers.get(q.id)) for q in questions}}
            on_slots = [q for q in questions if q.slot]
            if on_slots and p is not None:
                wf = st.workflow
                p, applied, notes = apply_answers(wf, p, on_slots, answers)
                self._remember(st.ctx, p)
                st.prepared, st.view.findings, st.changed = p, p.findings, st.changed or bool(applied)
                turn.emit("verdict", **p.preview())
                out.update(applied=applied, not_applied=notes, verdict=compact(p))
            return out

        def update_plan(a: dict) -> dict:
            steps = [{"id": f"s{i}", "label": str(s.get("label", "")).strip(),
                      "status": s.get("status") if s.get("status") in ("pending", "active", "done", "skipped")
                      else "pending"} for i, s in enumerate(a.get("steps") or []) if isinstance(s, dict)][:8]
            if not steps:
                return {"error": "a plan needs steps"}
            turn.emit("plan", steps=steps)
            return {"ok": True}

        def request_approval(a: dict) -> dict:
            action = str(a.get("action") or "")
            if action not in APPROVALS:
                return {"error": f"action must be one of {list(APPROVALS)}"}
            return {"approved": self._approve(turn, st, action, str(a.get("why") or "") or None,
                                              str(a.get("label") or "") or None)}

        def suggest_next(a: dict) -> dict:
            options = []
            for o in a.get("options") or []:
                if not isinstance(o, dict) or o.get("action") not in ACTIONS or not str(o.get("label") or "").strip():
                    continue
                item = {"label": str(o["label"]).strip(), "action": o["action"]}
                payload = o.get("payload")
                if o["action"] == "compare" and isinstance(payload, str) and " vs " in payload:
                    x, y = payload.split(" vs ", 1)
                    item["payload"] = {"a": x.strip(), "b": y.strip()}
                elif payload not in (None, ""):
                    item["payload"] = payload
                options.append(item)
            st.suggestions = options[:4]
            return {"ok": True, "shown": len(st.suggestions)}

        return [
            Tool("ask_user", "Show the scientist a question card and wait for the answers. Prefer `slots` (ids listed "
                 "under OPEN SLOTS): the engine supplies their options and effects, and the answers are saved as "
                 "confirmed facts. Use `questions` (2 to 5 short options each) only when no slot fits. At most 3.",
                 obj({"title": {"type": "string"}, "slots": {"type": "array", "items": {"type": "string"}},
                      "questions": {"type": "array", "items": obj(
                          {"text": {"type": "string"}, "why": {"type": "string"},
                           "options": {"type": "array", "items": {"type": "string"}}}, ["text", "options"])}}),
                 ask, lambda a: "Asking", interaction=True),
            Tool("update_plan", "Show or update the plan checklist for a task of 3 or more steps (the full plan each "
                 "time).",
                 obj({"steps": {"type": "array", "items": obj(
                     {"label": {"type": "string"},
                      "status": {"type": "string", "enum": ["pending", "active", "done", "skipped"]}},
                     ["label", "status"])}}, ["steps"]),
                 update_plan, lambda a: "Plan", interaction=True),
            Tool("request_approval", "Ask the scientist to approve a costly or external action before you run it: "
                 "assess.write (re-assessment), assess.write_deep (deep mode), web.search (external literature).",
                 obj({"action": {"type": "string", "enum": list(APPROVALS)}, "why": {"type": "string"},
                      "label": {"type": "string"}}, ["action", "why"]),
                 request_approval, lambda a: "Approval", interaction=True),
            Tool("suggest_next", "Offer 2 to 4 clickable next steps after your answer. Actions: draft_email, compare "
                 "(payload 'A vs B'), assess.write, assess.write_deep, web.search, ask (payload: the question).",
                 obj({"options": {"type": "array", "items": obj(
                     {"label": {"type": "string"}, "action": {"type": "string", "enum": list(ACTIONS)},
                      "payload": {"type": "string"}}, ["label", "action"])}}, ["options"]),
                 suggest_next, lambda a: "Next steps", interaction=True),
        ]

    def _assess_tools(self, turn: Turn, st: AgentState) -> list[Tool]:
        slots = slot_help(self.kb)

        def prepare(a: dict) -> dict:
            text = str(a.get("enquiry") or "").strip()
            if not text or not grounded(text, [st.message]):
                return {"error": "a new enquiry must be copied verbatim from the scientist's message"}
            turn.check()
            self.store.begin_enquiry(st.ctx.sid, text)
            with self._lock:
                self._memory.pop(st.ctx.sid, None)
            self._assess(turn, self._context(st.ctx.session))
            return {"ok": True}

        def preview(a: dict, save: bool) -> dict:
            wf, p = self._engine(turn, st)
            if p is None:
                return {"error": "the enquiry has not been assessed yet"}
            slot, value = str(a.get("slot") or "").strip(), str(a.get("value") or "").strip()
            try:
                after = wf.answer(p, slot, value)
            except ValueError as exc:
                return {"error": str(exc), "slots": slots}
            base, now = outcome(p.sheet, p.findings), outcome(after.sheet, after.findings)
            out = {"slot": slot, "value": after.confirmed.get(slot, "unknown"), "saved": save,
                   "change": change(base, now) or "NO_CHANGE",
                   "effects": effects(base, now, p.sheet, wf.ontology) or ["no change to the recommendation"],
                   "before": compact(p), "after": compact(after)}
            if save:
                turn.check()
                self._remember(st.ctx, after)
                st.prepared, st.view.findings, st.changed = after, after.findings, True
                turn.emit("verdict", **after.preview())
            return out

        def record(a: dict) -> dict:
            text = " ".join(str(a.get("text") or "").split())
            if not text or not grounded(text, [st.message]):
                return {"recorded": False, "error": "a client fact must be copied word for word from the message"}
            facts, prefs = self.store.chat_state(st.ctx.sid)
            if text not in facts:
                facts = [*facts, text]
                self.store.set_chat_state(st.ctx.sid, facts, prefs)
            st.ctx.chat_facts, st.changed = facts, True
            return {"recorded": True, "text": text, "note": "used from the next re-assessment on"}

        def write(a: dict) -> dict:
            deep = str(a.get("mode") or "") == "deep" or st.ctx.deep
            action = "assess.write_deep" if deep else "assess.write"
            if (deep or st.ctx.report is not None) and not self._approve(turn, st, action):
                return {"declined": True, "note": "the scientist declined; nothing was re-run"}
            st.approved.discard(action)                    # each report execution needs its own approval
            web = st.ctx.web and self._approve(turn, st, "web.search")
            handle = self._rerun(turn, st.ctx, deep, web)
            if handle is None:
                return {"error": "there is no assessable enquiry in this session"}
            st.wrote = handle
            if handle.error or handle.result is None or handle.result.report is None:
                return {"error": f"the report run failed: {handle.error or 'no report'}"}
            report = handle.result.report
            st.view.report, st.view.findings = report, handle.result.findings
            st.view.versions = sorted(st.ctx.runs)
            st.view.sources += report_texts(report)
            return {"version": handle.version, **(report_summary(report) or {}),
                    "note": f"Report v{handle.version} is written and verified. Sum it up in 2 to 4 sentences with "
                            f"card ids."}

        effect = lambda r: r.get("error") or f"{r['change'].replace('_', ' ').lower()}: {r['effects'][0]}"
        return [
            Tool("assess.prepare", "The message is a complete new client enquiry, rather than a follow-up: start "
                 "the deterministic assessment flow (plan, prepare, questions, report and summary) and end this "
                 "turn. Copy the enquiry verbatim from the message. Never use this for a hypothetical or a new "
                 "fact about the existing client; use assess_what_if or assess_answer for those.",
                 obj({"enquiry": {"type": "string"}}, ["enquiry"]), prepare, lambda a: "New enquiry",
                 interaction=True),
            Tool("assess.what_if", "Preview what one answer would change (status, methods, probe, risks) without "
                 "saving it. Engine only, no cost. Slots and values: " + slots,
                 obj({"slot": {"type": "string"}, "value": {"type": "string"}}, ["slot", "value"]),
                 lambda a: preview(a, False), lambda a: f"What if {a.get('slot', '')} = {a.get('value', '')}",
                 effect),
            Tool("assess.answer", "Save a client fact the scientist stated as a confirmed slot value and update the "
                 "verdict at once (engine only, no cost). 'unknown' reopens a slot. Same slots as assess_what_if.",
                 obj({"slot": {"type": "string"}, "value": {"type": "string"}}, ["slot", "value"]),
                 lambda a: preview(a, True), lambda a: f"Recording {a.get('slot', '')} = {a.get('value', '')}",
                 effect),
            Tool("record_fact", "Save new client information that fits no slot, copied word for word from the "
                 "message. It is used from the next re-assessment on.",
                 obj({"text": {"type": "string"}}, ["text"]), record, lambda a: "Recording a client fact",
                 lambda r: r.get("error") or "saved"),
            Tool("assess.write", "Write a new report version from the session's facts (about 5 model calls). A "
                 "re-assessment and deep mode wait for the scientist's approval; the first report does not.",
                 obj({"mode": {"type": "string", "enum": ["standard", "deep"]}}), write,
                 lambda a: "Writing the report", interaction=True),
        ]

    # ------------------------------------------------------------ /messages

    def _legacy(self, turn: Turn, session: dict, text: str, start_run: Callable[[], str], web) -> None:
        with self._tool(turn, "chat.route", "Reading the message") as row:
            out = handle_message(session, text, store=self.store, kb=self.kb, gateway=self.gateway,
                                 retriever=self.retriever(), start_run=start_run, web=web)
            row["summary"] = out["kind"]
        turn.result = out
        if out["kind"] == "run":
            run = self.store.run(out["run_id"]) or {}
            turn.emit("report", run_id=out["run_id"], version=run.get("version"))
            return turn.complete("Started a new report version with the new information.")
        if out["kind"] == "refused":
            return turn.complete(out.get("reason", ""))
        labels = {cid: self.kb.cards[cid].citation() for cid in out.get("cited_ids", []) if cid in self.kb.cards}
        turn.complete(out.get("text", ""), labels,
                      **({"web_sources": out["web_sources"]} if out.get("web_sources") else {}))
