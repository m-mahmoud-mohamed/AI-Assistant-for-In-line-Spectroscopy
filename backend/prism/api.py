"""REST API and SSE run events for the PRISM UI (docs/ARCHITECTURE.md §7.2 and §8), and the assistant's turn API and
SSE turn events (CONTRACTS C4, prism/assist/harness.py).

Run with `uvicorn prism.api:app`; the module-level `app` is built lazily on first access.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import threading
import time
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from typing import Any

import fitz
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from prism import export as report_export
from prism.assist.harness import ACTIONS, Harness, RunHandle, bind, run_seed
from prism.assist.sections import SECTION_PATHS
from prism.assist.turns import TERMINAL as TURN_TERMINAL
from prism.assist.turns import Turns
from prism.cases import load_dev_cases, load_eval_cases, sha256_text
from prism.chat import diff, email_draft
from prism.kb.ingest import SOURCES, normalise
from prism.kb.loader import KnowledgeBase, refresh_imported
from prism.llm.gateway import LLMUnavailable
from prism.llm.profiles import LEGACY_ROLES
from prism.orchestrator import Pipeline, PipelineFlags, Prepared, RunResult
from prism.routes import connectors as routes_connectors
from prism.routes import sources as routes_sources
from prism.routes import speech as routes_speech
from prism.schemas import AssessmentReport, Enquiry, ReportBody, RuleFindings, iter_segments
from prism.sources.service import SourceService, set_default_service
from prism.sources.storage import SourceStore
from prism.stages.render import key_unknowns, stated_facts
from prism.stages.retrieve import Retriever
from prism.store import Store, new_id
from prism.units import Range

log = logging.getLogger(__name__)

TERMINAL = ("run_completed", "run_refused", "run_failed")
TERMINAL_GRACE_S = 3.0               # a finished run's terminal event may land a moment after the run row
PAGE_DPI = 120
QUOTE_PREFIX = 60
HIGHLIGHT = (1.0, 0.541, 0.0)        # --fiber-orange #FF8A00
TURN_FINISHED = ("completed", "failed", "stopped")
RESTARTED = "The server restarted during this turn. Ask again to continue."

PipelineFactory = Callable[[bool, Callable[[dict], None]], Pipeline]


class SessionIn(BaseModel):
    text: str | None = None
    title: str | None = None
    case_id: str | None = None


class RunIn(BaseModel):
    deep: bool = False
    web: bool = False                  # search the web and add verified external sources (opt-in)


class MessageIn(BaseModel):
    text: str


class TurnIn(BaseModel):
    text: str | None = None
    action: str | None = None          # a clicked suggestion (CONTRACTS C4 suggestion actions)
    payload: Any = None


class AnswerIn(BaseModel):
    question_id: str
    answers: dict[str, Any] = {}       # question id -> {value} | {values} | {unknown: true} | {other}


class ApproveIn(BaseModel):
    approval_id: str
    approved: bool


def result_payload(result: RunResult) -> dict:
    """Full run result as JSON (events are stored separately in the events table)."""
    def dump(model):
        return model.model_dump(mode="json") if model is not None else None
    return {"report": dump(result.report), "markdown": result.markdown, "findings": dump(result.findings),
            "scope": dump(result.scope), "manifest": dump(result.manifest), "sheet": dump(result.sheet),
            "pack": dump(result.pack), "verification": dump(result.verification), "web": dump(result.web)}


def partial_payload(prepared: Prepared, kb: KnowledgeBase, sections: list[str], body: ReportBody) -> dict:
    """`GET /runs/{id}/report` while the run is going: the sections verified so far, the decision status, the
    code-filled requirements and the cited sources, with the engine's findings (the report pane fills tab by tab)."""
    fields = [f for s in sections for f in SECTION_PATHS[s]]
    out = body.model_dump(mode="json", include={"decision_status", *fields})
    cited = dict.fromkeys(cid for path, seg in iter_segments(body) if re.split(r"[.\[]", path, maxsplit=1)[0] in fields
                          for cid in seg.evidence_ids)
    sheet, findings, enquiry = prepared.sheet, prepared.findings, prepared.enquiry
    return out | {
        "run_id": prepared.run_id, "partial": True, "sections": list(sections), "case_id": enquiry.case_id,
        "title": enquiry.title, "client_question": list(sheet.client_question),
        "streams": [s.model_dump(mode="json") for s in sheet.streams],
        "requirements": {"stated_facts": [f.model_dump(mode="json") for f in stated_facts(sheet)],
                         "key_unknowns": [u.model_dump(mode="json") for u in key_unknowns(sheet, findings)]},
        "sources": [{"id": c.id, "citation": c.citation(), "quote": c.quote, "scope": c.scope.value, "url": c.url,
                     "doi": c.doi} for c in kb.cards_for(cited)],
        "findings": findings.model_dump(mode="json"), "scope": prepared.scope.model_dump(mode="json")}


def _budget(gateway) -> dict[str, int]:
    meter = getattr(gateway, "budget", None)
    if meter is None:
        return {}
    snap = meter.snapshot()
    out = {}
    for window, remaining in snap["remaining"].items():
        value = remaining if remaining is not None else snap["limits"].get(window)
        if value is not None:
            out[window] = int(value)
    return out


def _routing(gateway) -> dict[str, str]:
    profile = getattr(gateway, "profile", None)
    return {role: rc.models[0] for role, rc in (profile.roles.items() if profile else [])
            if rc.models and role not in LEGACY_ROLES}


def page_png(materials: Path, doc: str, page: int, quote: str | None) -> tuple[bytes, int]:
    """Render a source page; highlight the first 60 characters of the normalised quote. Returns (png, hits)."""
    if doc not in SOURCES or not (materials / SOURCES[doc]).exists():
        raise HTTPException(404, f"unknown document {doc!r}")
    with fitz.open(materials / SOURCES[doc]) as pdf:
        if not 1 <= page <= len(pdf):
            raise HTTPException(404, f"{doc} has no page {page}")
        p = pdf[page - 1]
        rects = []
        if quote:
            needle = normalise(quote)[:QUOTE_PREFIX]
            rects = p.search_for(needle) or p.search_for(needle[:QUOTE_PREFIX // 2])
            for r in rects:
                p.draw_rect(r + (-2, -2, 2, 2), color=HIGHLIGHT, fill=HIGHLIGHT, fill_opacity=0.25, width=1.5)
        return p.get_pixmap(dpi=PAGE_DPI).tobytes("png"), len(rects)


def create_app(pipeline_factory: PipelineFactory, store: Store, kb: KnowledgeBase, gateway=None,
               materials: Path = Path("materials"), web=None) -> FastAPI:
    """`web` is an optional prism.web.WebService; it gives the chat agent its web tools in sessions whose
    latest run had the web flag. Pipeline factories receive `web=True` as a keyword for web runs."""
    materials = Path(materials)
    app = FastAPI(title="PRISM API", lifespan=routes_sources.lifespan)
    kb = replace(kb, cards=dict(kb.cards))
    app.state.sources = SourceService(SourceStore(store.db_path), gateway)
    kb.imported_sources = app.state.sources
    set_default_service(app.state.sources)
    # Feature routers (prism/routes/*) read the shared services from app.state.
    app.state.store, app.state.kb, app.state.gateway, app.state.materials = store, kb, gateway, materials
    for module in (routes_sources, routes_connectors, routes_speech):
        app.include_router(module.router)
    app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173"], allow_methods=["*"],
                       allow_headers=["*"], expose_headers=["X-Highlight-Count"])

    def session_or_404(session_id: str) -> dict:
        session = store.get_session(session_id)
        if session is None:
            raise HTTPException(404, f"unknown session {session_id!r}")
        return session

    def run_or_404(run_id: str) -> dict:
        run = store.run(run_id)
        if run is None:
            raise HTTPException(404, f"unknown run {run_id!r}")
        return run

    def cases() -> list[Enquiry]:
        out = load_dev_cases(materials)
        try:
            out += load_eval_cases(materials)
        except FileNotFoundError:
            pass
        return out

    @app.get("/api/health")
    def health():
        cache = getattr(gateway, "cache", None)
        profile = getattr(gateway, "profile", None)
        return {"status": "ok", "profile": getattr(profile, "name", "fake"),
                "replay": bool(getattr(cache, "replay", False)), "kb_hash": kb.version,
                "budget": _budget(gateway), "routing": _routing(gateway)}

    @app.get("/api/cases")
    def list_cases():
        return [{"case_id": c.case_id, "title": c.title, "kind": "dev" if c.case_id.startswith("D") else "eval"}
                for c in cases()]

    @app.post("/api/sessions")
    def create_session(body: SessionIn):
        text, title = (body.text or "").strip(), (body.title or "").strip()
        if body.case_id and not text:
            case = next((c for c in cases() if c.case_id == body.case_id), None)
            if case is None:
                raise HTTPException(404, f"unknown case {body.case_id!r}")
            text, title = case.text, title or f"{case.case_id} · {case.title}"
        if not text:
            raise HTTPException(422, "text or case_id is required")
        title = title or (text[:60] + ("…" if len(text) > 60 else ""))
        sid = store.create_session(title, body.case_id, text)
        return {k: v for k, v in session_or_404(sid).items() if k not in ("messages", "reports")}

    @app.get("/api/sessions")
    def list_sessions():
        return store.list_sessions()

    @app.get("/api/sessions/{session_id}")
    def get_session(session_id: str):
        # `active_turn_id`: an assistant turn still running or waiting, so a reopened session can attach to it.
        session = session_or_404(session_id)
        reports = []
        for r in session["reports"]:        # each version says what triggered it and what it changed
            rev = (store.report(r["run_id"]) or {}).get("revision") or {}
            reports.append({**r, "trigger": rev.get("trigger", ""), "summary": rev.get("summary", ""),
                            "changed_sections": rev.get("changed_sections", [])})
        return session | {"reports": reports, "active_turn_id": store.active_turn(session_id)}

    @app.post("/api/sessions/{session_id}/runs")
    def start_run(session_id: str, body: RunIn | None = None):
        return {"run_id": launch(session_or_404(session_id), bool(body and body.deep), bool(body and body.web))}

    def enquiry_for(session: dict) -> Enquiry | None:
        """The session's enquiry as the workflow takes it (None when the session has none yet)."""
        text = store.enquiry_text(session["id"])
        if not text:
            return None
        case_id = session["case_id"]
        title = next((c.title for c in cases() if c.case_id == case_id), "") if case_id else session["title"]
        return Enquiry(case_id=case_id or "ADHOC", title=title, text=text, sha256=sha256_text(text),
                       origin="case_file" if case_id else "ui")

    def workflow(deep: bool, web_on: bool, emit: Callable[[dict], None] | None = None) -> Pipeline:
        refresh_imported(kb)
        pipeline = pipeline_factory(deep, emit, web=True) if web_on else pipeline_factory(deep, emit)
        pipeline.kb = replace(kb, cards=dict(kb.cards), imported_frozen=True)
        pipeline.retriever = Retriever(pipeline.kb, pipeline.gateway if pipeline.flags.retrieval == "hybrid" else None)
        return pipeline

    def launch(session: dict, deep: bool = False, web_on: bool = False) -> str:
        """Start a background run with the session's enquiry, its stored chat facts and preferences, and the facts
        the scientist confirmed in the assistant."""
        session_id = session["id"]
        enquiry = enquiry_for(session)
        if enquiry is None:
            raise HTTPException(422, "session has no enquiry")
        chat_facts, preferences = store.chat_state(session_id)
        confirmed, _ = store.assist_state(session_id)
        run_id, _ = store.create_run(session_id, new_id())

        def produce(emit: Callable[[dict], None], partial) -> RunResult:
            pipeline = workflow(deep, web_on, emit)
            prepared = pipeline.prepare(enquiry, chat_facts, confirmed, preferences)
            return pipeline.write(prepared, preferences, on_partial=partial(prepared))

        threading.Thread(target=_execute, args=(run_id, session_id, produce), daemon=True,
                         name=f"run-{run_id}").start()
        return run_id

    def launch_prepared(session_id: str, wf: Pipeline, prepared: Prepared,
                        observe: Callable[[dict], None] | None = None,
                        announce: Callable[[RunHandle], None] | None = None) -> RunHandle:
        """A run that starts from a Prepared the assistant already has (its questions answered): the run stream
        opens with the prepare stages and the engine's current verdict, then writes, verifies and assembles."""
        run_id, version = store.create_run(session_id, new_id())
        for event in run_seed(prepared):
            store.add_event(run_id, {**event, "run_id": run_id})
        handle = RunHandle(run_id, version)

        def produce(emit: Callable[[dict], None], partial) -> RunResult:
            return wf.write(bind(prepared, emit), on_partial=partial(prepared))

        if announce is not None:
            announce(handle)
        threading.Thread(target=_execute, args=(run_id, session_id, produce, handle, observe), daemon=True,
                         name=f"run-{run_id}").start()
        return handle

    partials: dict[str, dict] = {}           # run id -> the report so far (served while the run is going)
    partial_lock = threading.Lock()

    def partial_sink(run_id: str) -> Callable[[Prepared], Callable[[str, ReportBody], None]]:
        def for_prepared(prepared: Prepared) -> Callable[[str, ReportBody], None]:
            def on_partial(section: str, body: ReportBody) -> None:
                with partial_lock:
                    ready = list(dict.fromkeys([*partials.get(run_id, {}).get("sections", []), section]))
                    partials[run_id] = partial_payload(prepared, kb, ready, body) | {"run_id": run_id}
            return on_partial
        return for_prepared

    def _execute(run_id: str, session_id: str, produce: Callable, handle: RunHandle | None = None,
                 observe: Callable[[dict], None] | None = None) -> None:
        held: list[dict] = []          # terminal events are stored after the report, so clients can fetch it
        last_stage: list[str | None] = [None]

        def emit(event: dict) -> None:
            if handle is not None:
                handle.check()                            # stop between workflow stages, never launch another call
            if event.get("type") == "stage_started":
                last_stage[0] = event.get("stage")
            event = {**event, "run_id": run_id}
            if event.get("type") in TERMINAL:
                held.append(event)
            else:
                store.add_event(run_id, event)
            if observe is not None:
                try:
                    observe(event)
                except Exception as exc:  # noqa: BLE001 - an observer never breaks the run
                    log.warning("run observer failed: %s", exc)

        try:
            result = produce(emit, partial_sink(run_id))
            store.finish_run(run_id, result_payload(result) | {"revision": result.revision})
            if result.pack is not None:
                store.add_web_cards(run_id, [c.model_dump(mode="json") for c in result.pack.cards
                                             if c.source == "EXT"])
            if result.report is None:
                store.add_message(session_id, "assistant", "refused", result.markdown, run_id)
            if not held:
                kind = "run_completed" if result.report is not None else "run_refused"
                held.append({"type": kind, "ts": time.time(), "stage": "render" if result.report else "scope",
                             "payload": {}})
            for event in held:
                store.add_event(run_id, {**event, "run_id": run_id})
            if handle is not None:
                handle.result = result
        except Exception as exc:  # noqa: BLE001 - any failure is reported to the UI as run_failed
            store.fail_run(run_id, f"{type(exc).__name__}: {exc}")
            store.add_event(run_id, {"type": "run_failed", "run_id": run_id, "ts": time.time(),
                                     "stage": last_stage[0], "payload": {"error": f"{type(exc).__name__}: {exc}"}})
            if handle is not None:
                handle.error = f"{type(exc).__name__}: {exc}"
        finally:
            with partial_lock:
                partials.pop(run_id, None)
            if handle is not None:
                handle.done.set()

    @app.get("/api/runs/{run_id}/events")
    async def run_events(run_id: str):
        run_or_404(run_id)

        async def stream():
            seq, finished_at = -1, None
            while True:
                batch = await asyncio.to_thread(store.events, run_id, seq)
                for event in batch:
                    seq = event["seq"]
                    yield {"data": json.dumps(event, ensure_ascii=False)}
                    if event["type"] in TERMINAL:
                        return
                if not batch:
                    run = await asyncio.to_thread(store.run, run_id)
                    if run["status"] != "running":
                        # The terminal event is stored just after the run row is marked finished: allow it a moment.
                        finished_at = finished_at or time.monotonic()
                        if time.monotonic() - finished_at > TERMINAL_GRACE_S and not await asyncio.to_thread(
                                store.events, run_id, seq):
                            return
                    await asyncio.sleep(0.1)

        return EventSourceResponse(stream(), ping=15)

    def finished(run_id: str) -> tuple[dict, dict]:
        run = run_or_404(run_id)
        if run["status"] == "running":
            raise HTTPException(409, "run is still running")
        if run["status"] == "failed":
            raise HTTPException(409, f"run failed: {run['error']}")
        return run, store.report(run_id)

    def version_info(run: dict, stored: dict) -> dict:
        """What the version is: its number, what triggered it and what changed (v1 is the initial assessment)."""
        rev = stored.get("revision") or {}
        default = "Initial assessment." if run["version"] == 1 else "Full re-assessment from the session's facts."
        return {"session_id": run["session_id"], "version": run["version"],
                "created_at": run["finished_at"] or run["started_at"], "trigger": rev.get("trigger", ""),
                "changed_sections": rev.get("changed_sections", []), "summary": rev.get("summary") or default,
                "follow_up_findings": rev.get("follow_up_findings", [])}

    def original_enquiry(run: dict, stored: dict) -> str:
        return (stored.get("revision") or {}).get("original_enquiry") or store.enquiry_text(run["session_id"]) or ""

    @app.get("/api/runs/{run_id}/report")
    def run_report(run_id: str):
        # While the run is going: the sections verified so far (409 until the first one is ready).
        if run_or_404(run_id)["status"] == "running":
            with partial_lock:
                partial = partials.get(run_id)
            if partial is not None:
                return partial
        run, result = finished(run_id)
        if result["report"] is None:
            return JSONResponse(status_code=422, content={"refused": True, "scope": result["scope"],
                                                          "markdown": result["markdown"]})
        report = {k: v for k, v in result["report"].items()
                  if k not in {"input_sha256", "kb_version", "profile", "model_ids", "prompt_hashes"}}
        return report | {"run_id": run_id, "findings": result["findings"], "scope": result["scope"],
                         "version_info": version_info(run, result),
                         "original_enquiry": original_enquiry(run, result),
                         "claim_verification": result.get("verification")}

    def export_input(run_id: str, version: int | None, appendix: str | None) -> report_export.ExportInput:
        """The inputs of an export: the run the user is looking at (or the session's `version`), its previous
        version and, on request, the conversation appendix."""
        run, result = finished(run_id)
        if version is not None and version != run["version"]:
            session = session_or_404(run["session_id"])
            other = next((r["run_id"] for r in session["reports"] if r["version"] == version), None)
            if other is None:
                raise HTTPException(404, f"session has no report version {version}")
            run, result = finished(other)
        if result["report"] is None:
            raise HTTPException(422, "a refused enquiry has no report to export")
        session = session_or_404(run["session_id"])
        conversation = report_export.parse_appendix(appendix)
        earlier = [r for r in session["reports"] if r["version"] < run["version"]]
        previous = store.report(earlier[-1]["run_id"]) if earlier else None
        findings = RuleFindings.model_validate(result["findings"]) if result.get("findings") else None
        messages = [{"role": m["role"], "kind": m["kind"], "text": m["text"]} for m in session["messages"]
                    if m["kind"] != "enquiry"] if conversation else None
        info = version_info(run, result)
        info = {**info, "summary": "" if run["version"] == 1 else info["summary"]}
        return report_export.ExportInput(
            report=AssessmentReport.model_validate({**result["report"], "run_id": run["id"]}), version=run["version"],
            versions=len(session["reports"]), enquiry=original_enquiry(run, result),
            revision=info,
            findings=findings, verification=result.get("verification"),
            previous=AssessmentReport.model_validate(previous["report"]) if previous and previous.get("report") else None,
            previous_version=earlier[-1]["version"] if earlier else 0, conversation=messages, kb=kb)

    @app.get("/api/runs/{run_id}/report.md")
    def run_report_md(run_id: str, version: int | None = None, appendix: str | None = None):
        inp = export_input(run_id, version, appendix)
        return Response(report_export.render_markdown(report_export.build(inp)),
                        media_type="text/markdown; charset=utf-8")

    @app.get("/api/runs/{run_id}/report.json")
    def run_report_json(run_id: str, version: int | None = None, appendix: str | None = None):
        inp = export_input(run_id, version, appendix)
        return Response(report_export.render_json(report_export.build(inp)), media_type="application/json")

    @app.get("/api/runs/{run_id}/report.doc")
    def run_report_doc(run_id: str, version: int | None = None, appendix: str | None = None):
        """The print document as JSON blocks (the app's own print view is drawn from them)."""
        return report_export.render_doc(report_export.build(export_input(run_id, version, appendix)))

    @app.get("/api/runs/{run_id}/report.html")
    def run_report_html(run_id: str, version: int | None = None, appendix: str | None = None):
        """The print document as a web page (the browser-print fallback): A4, 18 mm margins, light colours."""
        return Response(report_export.render_html(report_export.build(export_input(run_id, version, appendix))),
                        media_type="text/html; charset=utf-8")

    @app.get("/api/runs/{run_id}/report.pdf")
    def run_report_pdf(run_id: str, version: int | None = None, appendix: str | None = None):
        doc = report_export.build(export_input(run_id, version, appendix))
        return Response(report_export.render_pdf(doc), media_type="application/pdf",
                        headers={"Content-Disposition": f'inline; filename="prism-report-v{doc.version}.pdf"'})

    @app.get("/api/kb/cards/{card_id}")
    def card(card_id: str, run: str | None = None):
        """A KB card, or a verified web card of a run (`run` narrows the lookup; default: latest run with it)."""
        if card_id in kb.cards:
            return kb.cards[card_id].model_dump(mode="json")
        web_card = store.web_card(card_id, run)
        if web_card is None:
            raise HTTPException(404, f"unknown card {card_id!r}")
        return web_card

    @app.get("/api/runs/{run_id}/web-sources")
    def run_web_sources(run_id: str):
        """Every web source a run looked at: the kept cards (with their verification) and the rejected ones."""
        _, result = finished(run_id)
        web_report = result.get("web") or {"enabled": False, "queries": [], "considered": 0, "sources": []}
        cards = [c for c in (result.get("pack") or {}).get("cards", []) if c.get("source") == "EXT"]
        return {"run_id": run_id, **web_report, "cards": cards}

    @app.get("/api/kb/pages/{doc}/{page}.png")
    def page_image(doc: str, page: int, highlight: str | None = None):
        quote = None
        if highlight:
            c = kb.cards.get(highlight)
            if c is None:
                raise HTTPException(404, f"unknown card {highlight!r}")
            quote = c.quote if (c.source, c.page) == (doc, page) else None
        png, hits = page_png(materials, doc, page, quote)
        return Response(png, media_type="image/png",
                        headers={"X-Highlight-Count": str(hits), "Cache-Control": "max-age=3600"})

    @app.get("/api/kb/spectral")
    def spectral():
        def ranges(r: Range) -> dict:
            lo, hi = r.as_cm1()
            return {"range_um": [r.lo_um, r.hi_um], "range_cm1": [round(lo, 1), round(hi, 1)]}
        methods = [{"id": m["id"], "name": m.get("name", m["id"]), **ranges(kb.method_range(m["id"])),
                    "cards": list(m.get("range_cards", []))} for m in kb.methods.values()]
        fibers = [{"id": f["id"], "name": f.get("name", f["id"]), "range_um": ranges(kb.fiber_range(f["id"]))
                   ["range_um"], "card": f["card"]} for f in kb.fibers.values()]
        return {"methods": methods, "fibers": fibers, "instruments": []}

    # ------------------------------------------------------------------ chat (docs/AI_ARCHITECTURE.md §5)

    retriever: list[Retriever] = []          # built on first chat use (may embed the KB once)

    def chat_gateway():
        if gateway is None:
            raise HTTPException(503, "no LLM gateway configured")
        return gateway

    def report_at(session: dict, version: int) -> AssessmentReport:
        run_id = next((r["run_id"] for r in session["reports"] if r["version"] == version), None)
        if run_id is None:
            raise HTTPException(404, f"session has no report version {version}")
        return AssessmentReport.model_validate(store.report(run_id)["report"])

    def last_flag(session: dict, name: str) -> bool:
        """Chat re-runs keep the run flags (deep, web) of the session's latest run."""
        if not session["reports"]:
            return False
        latest = max(session["reports"], key=lambda r: r["version"])
        stored = store.report(latest["run_id"]) or {}
        return str(((stored.get("manifest") or {}).get("flags") or {}).get(name, "False")) == "True"

    def last_deep(session: dict) -> bool:
        return last_flag(session, "deep")

    def chat_retriever() -> Retriever:
        if not retriever:
            retriever.append(Retriever(kb, gateway))
        return retriever[0]

    turns = Turns(store)
    app.state.turns = turns  # Connector tools use the existing turn approval and cancellation interface.
    store.interrupt_turns(RESTARTED)        # turns left open by a previous process have no thread any more
    harness = Harness(store, kb, turns, lambda deep, web_on: workflow(deep, web_on), launch_prepared, enquiry_for,
                      gateway=gateway, web=web, retriever=chat_retriever)

    @app.post("/api/sessions/{session_id}/messages")
    def post_message(session_id: str, body: MessageIn):
        """The original chat endpoint: its routing runs as an assistant turn, and the reply keeps its shape."""
        session = session_or_404(session_id)
        if not body.text.strip():
            raise HTTPException(422, "text is required")
        chat_gateway()
        try:
            out = harness.message(session, body.text,
                                  start_run=lambda: launch(session, last_deep(session), last_flag(session, "web")),
                                  web=web if last_flag(session, "web") else None)
        except LLMUnavailable as exc:
            raise HTTPException(503, str(exc)) from exc
        if out is None:
            raise HTTPException(409, "a newer message interrupted this one")
        return out

    # ------------------------------------------------------------------ assistant turns (CONTRACTS C4)

    def turn_or_404(turn_id: str) -> dict:
        turn = store.turn(turn_id)
        if turn is None:
            raise HTTPException(404, f"unknown turn {turn_id!r}")
        return turn

    @app.post("/api/sessions/{session_id}/turns")
    def start_turn(session_id: str, body: TurnIn):
        session = session_or_404(session_id)
        text = (body.text or "").strip()
        if body.action is None and not text:
            raise HTTPException(422, "text or action is required")
        if body.action is not None and body.action not in ACTIONS:
            raise HTTPException(422, f"unknown action {body.action!r}; one of {list(ACTIONS)}")
        return {"turn_id": harness.start(session, text or None, body.action, body.payload)}

    @app.get("/api/turns/{turn_id}")
    def get_turn(turn_id: str):
        return turn_or_404(turn_id)

    @app.get("/api/turns/{turn_id}/events")
    async def turn_events(turn_id: str, request: Request, after: int | None = None):
        """The turn's events from the start, or after `Last-Event-ID` (each frame carries its `seq` as the id)."""
        turn_or_404(turn_id)
        last = request.headers.get("last-event-id", "").strip()
        start = int(last) if re.fullmatch(r"-?\d+", last) else (after if after is not None else -1)

        async def stream():
            seq = start
            while True:
                batch = await asyncio.to_thread(store.turn_events, turn_id, seq)
                for event in batch:
                    seq = event["seq"]
                    yield {"id": str(seq), "data": json.dumps(event, ensure_ascii=False)}
                    if event["type"] in TURN_TERMINAL:
                        return
                if not batch:
                    turn = await asyncio.to_thread(store.turn, turn_id)
                    if turn["status"] in TURN_FINISHED and not await asyncio.to_thread(store.turn_events, turn_id, seq):
                        return          # resumed after the terminal event: nothing more will come
                    await asyncio.sleep(0.1)

        return EventSourceResponse(stream(), ping=15)

    @app.post("/api/turns/{turn_id}/answer")
    def answer_turn(turn_id: str, body: AnswerIn):
        turn_or_404(turn_id)
        live = turns.get(turn_id)
        if live is None or not live.reply("question", body.question_id, {"answers": body.answers}):
            raise HTTPException(409, f"the turn is not waiting for question {body.question_id!r}")
        return {"ok": True}

    @app.post("/api/turns/{turn_id}/approve")
    def approve_turn(turn_id: str, body: ApproveIn):
        turn_or_404(turn_id)
        live = turns.get(turn_id)
        if live is None or not live.reply("approval", body.approval_id, bool(body.approved)):
            raise HTTPException(409, f"the turn is not waiting for approval {body.approval_id!r}")
        return {"ok": True}

    @app.post("/api/turns/{turn_id}/stop")
    def stop_turn(turn_id: str):
        turn_or_404(turn_id)
        live = turns.get(turn_id)
        if live is not None:
            live.stop()
        return {"ok": True}

    @app.get("/api/sessions/{session_id}/diff")
    def report_diff(session_id: str, from_: int | None = Query(None, alias="from"), to: int | None = None):
        session = session_or_404(session_id)
        versions = [r["version"] for r in session["reports"]]
        if not versions:
            raise HTTPException(404, "session has no reports")
        to = versions[-1] if to is None else to
        from_ = max((v for v in versions if v < to), default=to) if from_ is None else from_
        a, b = report_at(session, from_), report_at(session, to)
        return diff(a, b) | {"sections": report_export.section_changes(a, b), "from": from_, "to": to}

    @app.post("/api/sessions/{session_id}/email-draft")
    def post_email_draft(session_id: str):
        session_or_404(session_id)
        latest = store.latest_report(session_id)
        if not latest or not latest.get("report"):
            raise HTTPException(409, "session has no report yet")
        try:
            text = email_draft(AssessmentReport.model_validate(latest["report"]), chat_gateway())
        except LLMUnavailable as exc:
            raise HTTPException(503, str(exc)) from exc
        return {"text": text}

    return app


def build_default_app() -> FastAPI:
    from prism.kb.loader import load_kb
    from prism.llm.gateway import build_gateway
    from prism.web import WebService

    gateway, kb, materials = build_gateway(), load_kb(), Path("materials")
    web_service = WebService.for_gateway(gateway)    # no network until a web run or a web chat turn asks for it

    def factory(deep: bool, emit: Callable[[dict], None], web: bool = False) -> Pipeline:
        return Pipeline(gateway, kb, materials, PipelineFlags(deep=deep, web=web), emit=emit, web=web_service)

    return create_app(factory, Store(), kb, gateway=gateway, materials=materials, web=web_service)


def __getattr__(name: str):
    # Lazy module-level `app` so importing prism.api (e.g. in tests) builds no gateway and opens no database.
    if name == "app":
        globals()["app"] = build_default_app()
        return globals()["app"]
    raise AttributeError(name)
