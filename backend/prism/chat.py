"""Chat agent (docs/AI_ARCHITECTURE.md §5): intent routing, grounded tool-using answers, report diff, e-mail draft."""
from __future__ import annotations

import json
import re
from collections.abc import Callable
from enum import Enum

from pydantic import BaseModel, Field
from rapidfuzz import fuzz

from prism.kb.loader import KnowledgeBase
from prism.llm.gateway import ToolSpec
from prism.llm.prompts import render
from prism.schemas import (
    AssessmentReport,
    ClaimType,
    DecisionStatus,
    DirectAnswer,
    FeasibilityPlan,
    ReportBody,
    Requirements,
    ScopeDecision,
    ScopeLabel,
    Segment,
    Verdict,
)
from prism.stages.checks import CheckContext, check_numbers, check_wording
from prism.stages.extract import grounded
from prism.stages.scope import guard, refusal_text, signal_scores
from prism.units import UNIT_ALIASES, convert

MAX_STEPS = 4
SAME_TEXT = 88            # rapidfuzz token_sort_ratio at which two questions / risks count as the same
MIN_FUZZY_LEN = 30        # shorter texts must match exactly
GUARD_NOTE = ("Note: I removed a statement I could not ground in the report or its evidence cards. If you need "
              "that detail, ask for a re-assessment or put the question to the client.")
REPORT_SECTIONS = ("decision_status", "direct_answer", "premise_checks", "requirements", "clarification_questions",
                   "recommendations", "measurement_concept", "spectral_ranges", "risks", "assumptions",
                   "feasibility_plan", "decision_basis", "client_question", "streams", "interpretations", "sources")
_SENTENCE = re.compile(r"(?<=[.!?])\s+(?=\S)")


# ---------------------------------------------------------------- intent

class IntentKind(str, Enum):
    NEW_CLIENT_INFO = "NEW_CLIENT_INFO"
    QUESTION_ABOUT_REPORT = "QUESTION_ABOUT_REPORT"
    INSTRUCTION = "INSTRUCTION"


class ChatIntent(BaseModel):
    kind: IntentKind
    fact_text: str | None = Field(None, description="NEW_CLIENT_INFO only: the new information, copied verbatim "
                                                    "from the message")
    preference: str | None = Field(None, description="INSTRUCTION only: the expert's preference in a few words")


def chat_guard(message: str, kb: KnowledgeBase, gateway=None) -> ScopeDecision:
    """Scope guard for follow-up messages. Inside an assessed session one domain signal is enough;
    otherwise the stage-0b guard decides (signals → classifier)."""
    ins, off, unsafe = signal_scores(message, kb.lexicon)
    if not unsafe and ins >= 1 and off == 0:
        return ScopeDecision(label=ScopeLabel.IN_SCOPE, reason="Follow-up about the assessment (keyword signals).")
    return guard(message, kb, gateway)


def classify(message: str, gateway) -> ChatIntent:
    prompt, _ = render("classify.j2", text=message)
    return gateway.complete("classifier", [{"role": "user", "content": prompt}], schema=ChatIntent,
                            reasoning="off").parsed


def ground_fact(fact_text: str | None, message: str) -> str:
    """A chat fact must be the client's words: the classifier's text if it is a verbatim substring of the
    message, else the whole message (never a paraphrase that could add information)."""
    fact = (fact_text or "").strip()
    return fact if fact and grounded(fact, [message]) else message.strip()


# ---------------------------------------------------------------- deterministic tools

def _resolve(name: str, ids, aliases: dict) -> str | None:
    key = name.strip().lower()
    for i in ids:
        if i.lower() == key:
            return i
    for i, names in aliases.items():
        if i in ids and key in (str(n).lower() for n in names):
            return i
    return None


def card_summary(kb: KnowledgeBase, card_id: str) -> dict:
    c = kb.cards[card_id]
    return {"id": c.id, "citation": c.citation(), "claim": c.claim, "quote": c.quote, "scope": c.scope.value,
            **({"url": c.url, "retrieved_at": c.retrieved_at} if c.source == "EXT" else {})}


def check_fiber_window(kb: KnowledgeBase, method: str, fiber_family: str) -> dict:
    m = _resolve(method, kb.methods, kb.lexicon.get("methods", {}))
    f = _resolve(fiber_family, kb.fibers, kb.lexicon.get("fibers", {}))
    if m is None or f is None:
        return {"error": f"unknown {'method' if m is None else 'fiber family'}",
                "methods": sorted(kb.methods), "fiber_families": sorted(kb.fibers)}
    mr, fr = kb.method_range(m), kb.fiber_range(f)
    ov = mr.overlap(fr)
    card_ids = [*kb.methods[m].get("range_cards", []), kb.fibers[f]["card"]]
    return {"method": m, "fiber_family": f, "method_range_um": [mr.lo_um, mr.hi_um],
            "fiber_range_um": [fr.lo_um, fr.hi_um], "overlap": ov is not None,
            "overlap_um": [ov.lo_um, ov.hi_um] if ov else None,
            "coverage_of_method_range": round(mr.coverage_by(fr), 3),
            "cards": [card_summary(kb, c) for c in card_ids if c in kb.cards]}


def convert_units(value: float, from_unit: str, to_unit: str) -> float:
    return round(convert(float(value), from_unit, to_unit), 4)


def explain_rule(kb: KnowledgeBase, rule_id: str) -> dict:
    r = kb.rules_meta.get(rule_id.strip())
    if r is None:
        return {"error": f"unknown rule {rule_id!r}", "rules": sorted(kb.rules_meta)}
    return {"rule_id": r["id"], "description": r.get("description", ""), "severity": r.get("severity"),
            "cards": [card_summary(kb, c) for c in r.get("sources", []) if c in kb.cards]}


def report_section(report: AssessmentReport | None, name: str):
    if report is None:
        return {"error": "there is no report for this session yet"}
    if name not in REPORT_SECTIONS:
        return {"error": f"unknown section {name!r}", "sections": list(REPORT_SECTIONS)}
    return {"section": name, "content": report.model_dump(mode="json", include={name})[name]}


def _obj(props: dict, required: list[str]) -> dict:
    return {"type": "object", "properties": props, "required": required}


def build_tools(kb: KnowledgeBase, report: AssessmentReport | None, retriever,
                on_fact: Callable[[str], bool]) -> list[ToolSpec]:
    def search(a: dict) -> dict:
        k = max(1, min(int(a.get("k") or 5), 10))
        return {"cards": [card_summary(kb, c) for c in retriever.search(str(a["query"]), k=k)]}

    def get_card(a: dict) -> dict:
        cid = str(a["card_id"])
        return card_summary(kb, cid) if cid in kb.cards else {"error": f"unknown card {cid!r}"}

    def units(a: dict) -> dict:
        f, t = str(a["from_unit"]), str(a["to_unit"])
        if f.strip() not in UNIT_ALIASES or t.strip() not in UNIT_ALIASES:
            return {"error": "supported units: nm, um, cm-1"}
        return {"value": convert_units(a["value"], f, t), "unit": UNIT_ALIASES[t.strip()],
                "input": {"value": a["value"], "unit": UNIT_ALIASES[f.strip()]}}

    def propose(a: dict) -> dict:
        text = str(a["text"]).strip()
        ok = on_fact(text)
        return ({"recorded": True, "needs_confirmation": True, "text": text} if ok else
                {"recorded": False, "error": "a fact must be copied verbatim from the user's message"})

    return [
        ToolSpec("search_evidence", "Search the AFS knowledge base for evidence cards.",
                 _obj({"query": {"type": "string"}, "k": {"type": "integer", "minimum": 1, "maximum": 10}},
                      ["query"]), search),
        ToolSpec("get_card", "Claim, verbatim quote, citation and scope of one evidence card.",
                 _obj({"card_id": {"type": "string"}}, ["card_id"]), get_card),
        ToolSpec("get_report_section", "One section of the current report version.",
                 _obj({"name": {"type": "string", "enum": list(REPORT_SECTIONS)}}, ["name"]),
                 lambda a: report_section(report, str(a["name"]))),
        ToolSpec("check_fiber_window", "Does a fiber family transmit a method's nominal range? Returns the "
                 "overlap and the source cards.",
                 _obj({"method": {"type": "string", "enum": sorted(kb.methods)},
                       "fiber_family": {"type": "string", "enum": sorted(kb.fibers)}}, ["method", "fiber_family"]),
                 lambda a: check_fiber_window(kb, str(a["method"]), str(a["fiber_family"]))),
        ToolSpec("convert_units", "Convert between nm, um and cm-1.",
                 _obj({"value": {"type": "number"}, "from_unit": {"type": "string", "enum": ["nm", "um", "cm-1"]},
                       "to_unit": {"type": "string", "enum": ["nm", "um", "cm-1"]}},
                      ["value", "from_unit", "to_unit"]), units),
        ToolSpec("explain_rule", "Description, severity and source cards of a rule (e.g. R-FIBER-WINDOW).",
                 _obj({"rule_id": {"type": "string"}}, ["rule_id"]),
                 lambda a: explain_rule(kb, str(a["rule_id"]))),
        ToolSpec("propose_fact", "Record new client information, copied verbatim from the user's message. The "
                 "user must confirm it before a re-assessment.",
                 _obj({"text": {"type": "string"}}, ["text"]), propose),
    ]


# ---------------------------------------------------------------- grounded answer

class ChatAnswer(BaseModel):
    text: str
    cited_ids: list[str] = Field(default_factory=list)
    tool_calls: list[dict] = Field(default_factory=list)
    proposed_facts: list[dict] = Field(default_factory=list)


def _probe_body(sentences: list[str], ids: list[str]) -> ReportBody:
    """A report-shaped container so the report checks can judge chat sentences (decision_basis[i] = sentence i)."""
    ct = ClaimType.AFS if ids else ClaimType.PROPOSAL
    return ReportBody.model_construct(
        decision_status=DecisionStatus.PROVISIONAL,
        direct_answer=DirectAnswer.model_construct(verdict=Verdict.NOT_APPLICABLE, text=[]),
        premise_checks=[], requirements=Requirements(), clarification_questions=[], recommendations=[],
        measurement_concept=[], spectral_ranges=[], risks=[], assumptions=[],
        feasibility_plan=FeasibilityPlan.model_construct(objective="", steps=[]),
        decision_basis=[Segment(text=s, claim_type=ct, evidence_ids=list(ids)) for s in sentences])


def _report_texts(report: AssessmentReport | None) -> list[str]:
    if report is None:
        return []
    body = report.model_dump_json(include=set(ReportBody.model_fields) | {"client_question", "streams"})
    return [body, *(f"{s.citation} {s.quote}" for s in report.sources)]


def mentioned_ids(text: str, kb: KnowledgeBase) -> list[str]:
    hits = [(text.find(cid), cid) for cid in kb.cards if cid in text]
    return [cid for _, cid in sorted(hits)]


def guard_text(text: str, kb: KnowledgeBase, cited_ids: list[str], source_texts: list[str]) -> tuple[str, int]:
    """Drop sentences that fail the number guard or the wording checks; return (text, removed count)."""
    sentences = [s.strip() for s in _SENTENCE.split(text.strip()) if s.strip()]
    if not sentences:
        return "", 0
    # Card ids are citations, not values or product codes: judge each sentence without them.
    probe = []
    for s in sentences:
        for cid in kb.cards:
            s = s.replace(cid, "")
        probe.append(s.strip() or ".")
    cx = CheckContext(_probe_body(probe, cited_ids), None, None, None, kb, source_texts)
    bad = {int(m.group(1)) for i in check_numbers(cx) + check_wording(cx)
           if (m := re.fullmatch(r"decision_basis\[(\d+)\]", i.path))}
    kept = [s for i, s in enumerate(sentences) if i not in bad]
    return " ".join(kept), len(bad)


def _summary(report: AssessmentReport | None) -> dict | None:
    if report is None:
        return None
    return {"status": report.decision_status.value, "verdict": report.direct_answer.verdict.value,
            "direct_answer": " ".join(s.text for s in report.direct_answer.text),
            "recommendations": [f"{'+'.join(r.methods)} {r.technique} ({r.role.value})" for r in report.recommendations],
            "questions": [q.question for q in sorted(report.clarification_questions, key=lambda q: q.priority)],
            "source_ids": [s.id for s in report.sources]}


def _args(raw) -> dict:
    if isinstance(raw, dict):
        return raw
    try:
        out = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {"raw": str(raw)}
    return out if isinstance(out, dict) else {"value": out}


def _result_ids(result) -> list[str]:
    """Card ids returned by a tool result (any 'id' inside a 'cards' list or a single card)."""
    out: list[str] = []
    if isinstance(result, dict):
        if "id" in result and "citation" in result:
            out.append(result["id"])
        for c in result.get("cards", []) or []:
            if isinstance(c, dict) and "id" in c:
                out.append(c["id"])
    return out


def answer(message: str, report: AssessmentReport | None, kb: KnowledgeBase, retriever, gateway) -> ChatAnswer:
    proposed: list[dict] = []

    def on_fact(text: str) -> bool:
        if not text or not grounded(text, [message]):
            return False
        if all(p["text"] != text for p in proposed):
            proposed.append({"text": text})
        return True

    tools = build_tools(kb, report, retriever, on_fact)
    system, _ = render("agent.j2", report=_summary(report), tools=[t.name for t in tools], max_steps=MAX_STEPS)
    res = gateway.run_tools("agent", [{"role": "system", "content": system}, {"role": "user", "content": message}],
                            tools, max_steps=MAX_STEPS)
    calls = [{"name": c["name"], "arguments": _args(c.get("arguments")), "result": c.get("result")}
             for c in res.calls]
    returned = {cid for c in calls for cid in _result_ids(c["result"])}
    allowed = returned | ({s.id for s in report.sources} if report else set())
    cited = [cid for cid in mentioned_ids(res.text, kb) if cid in allowed]
    sources = [message, *_report_texts(report), *(json.dumps(c["result"], ensure_ascii=False) for c in calls)]
    text, removed = guard_text(res.text, kb, cited, sources)
    if removed:
        text = f"{text}\n\n{GUARD_NOTE}".strip()
    cited = [cid for cid in cited if cid in text]
    return ChatAnswer(text=text, cited_ids=cited, tool_calls=calls, proposed_facts=proposed)


# ---------------------------------------------------------------- routing

def handle_message(session: dict, message: str, *, store, kb: KnowledgeBase, gateway, retriever,
                   start_run: Callable[[], str]) -> dict:
    """Route one chat message. Returns {kind:'run', run_id} | {kind:'answer', …} | {kind:'refused', …}."""
    sid, message = session["id"], message.strip()
    decision = chat_guard(message, kb, gateway)
    if decision.label in (ScopeLabel.OFF_TOPIC, ScopeLabel.UNSAFE):
        store.add_message(sid, "user", "question", message)
        store.add_message(sid, "assistant", "refused", refusal_text(decision))
        return {"kind": "refused", "reason": decision.reason, "suggestions": list(decision.suggestions)}
    intent = classify(message, gateway)
    facts, prefs = store.chat_state(sid)
    if intent.kind in (IntentKind.NEW_CLIENT_INFO, IntentKind.INSTRUCTION):
        if intent.kind == IntentKind.NEW_CLIENT_INFO:
            fact = ground_fact(intent.fact_text, message)
            facts = facts if fact in facts else [*facts, fact]
            kind = "new_client_info"
        else:
            pref = (intent.preference or "").strip() or message
            prefs = prefs if pref in prefs else [*prefs, pref]
            kind = "instruction"
        store.set_chat_state(sid, facts, prefs)
        run_id = start_run()
        store.add_message(sid, "user", kind, message, run_id)
        return {"kind": "run", "run_id": run_id}
    latest = store.latest_report(sid)
    report = AssessmentReport.model_validate(latest["report"]) if latest and latest.get("report") else None
    ans = answer(message, report, kb, retriever, gateway)
    store.add_message(sid, "user", "question", message)
    store.add_message(sid, "assistant", "answer", ans.text)
    return {"kind": "answer", **ans.model_dump(mode="json")}


# ---------------------------------------------------------------- diff and e-mail

def _rec_key(r) -> tuple[tuple[str, ...], str]:
    return tuple(sorted(r.methods)), " ".join(r.technique.lower().split())


def _norm(text: str) -> str:
    return " ".join(re.findall(r"\w+", text.lower()))


def _match(text: str, pool: list[str]) -> bool:
    """Same question / risk across versions: identical words, or a close rewording of a longer sentence
    (short texts must match exactly, since one changed word can change their meaning)."""
    t = _norm(text)
    return any(t == (p := _norm(x)) or (min(len(t), len(p)) >= MIN_FUZZY_LEN
                                       and fuzz.token_sort_ratio(t, p) >= SAME_TEXT) for x in pool)


def _risk_text(risk) -> str:
    return " ".join(s.text for s in risk.risk)


def diff(a: AssessmentReport, b: AssessmentReport) -> dict:
    """Structural change list from report version a to version b."""
    ra = {_rec_key(r): r for r in a.recommendations}
    rb = {_rec_key(r): r for r in b.recommendations}

    def rec(r) -> dict:
        return {"methods": list(r.methods), "technique": r.technique, "role": r.role.value}

    qa = [q.question for q in a.clarification_questions]
    qb = [q.question for q in b.clarification_questions]
    xa, xb = [_risk_text(r) for r in a.risks], [_risk_text(r) for r in b.risks]
    return {
        "status": ({"from": a.decision_status.value, "to": b.decision_status.value}
                   if a.decision_status != b.decision_status else None),
        "verdict": ({"from": a.direct_answer.verdict.value, "to": b.direct_answer.verdict.value}
                    if a.direct_answer.verdict != b.direct_answer.verdict else None),
        "recommendations": {
            "added": [rec(r) for k, r in rb.items() if k not in ra],
            "removed": [rec(r) for k, r in ra.items() if k not in rb],
            "changed": [{"methods": list(r.methods), "technique": r.technique, "from_role": ra[k].role.value,
                         "to_role": r.role.value} for k, r in rb.items() if k in ra and ra[k].role != r.role]},
        "questions": {"resolved": [q for q in qa if not _match(q, qb)], "new": [q for q in qb if not _match(q, qa)]},
        "risks": {"added": [x for x in xb if not _match(x, xa)], "removed": [x for x in xa if not _match(x, xb)]},
    }


def email_draft(report: AssessmentReport, gateway) -> str:
    questions = [{"question": q.question, "why": q.why_it_matters}
                 for q in sorted(report.clarification_questions, key=lambda q: q.priority)]
    recs = [f"{' + '.join(r.methods)} {r.technique} ({r.role.value.lower()})" for r in report.recommendations
            if r.role.value != "NOT_RECOMMENDED"]
    prompt, _ = render("email.j2", title=report.title, client_question=report.client_question,
                       questions=questions, recommendations=recs)
    return gateway.complete("generator", [{"role": "user", "content": prompt}]).text.strip()
