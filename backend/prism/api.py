"""REST API and SSE run events for the PRISM UI (docs/ARCHITECTURE.md §7.2 and §8).

Run with `uvicorn prism.api:app`; the module-level `app` is built lazily on first access.
"""
from __future__ import annotations

import asyncio
import json
import threading
import time
from collections.abc import Callable
from pathlib import Path

import fitz
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from prism.cases import load_dev_cases, load_eval_cases, sha256_text
from prism.chat import diff, email_draft, handle_message
from prism.kb.ingest import SOURCES, normalise
from prism.kb.loader import KnowledgeBase
from prism.llm.gateway import LLMUnavailable
from prism.orchestrator import Pipeline, PipelineFlags, RunResult
from prism.schemas import AssessmentReport, Enquiry
from prism.stages.retrieve import Retriever
from prism.store import Store, new_id
from prism.units import Range

TERMINAL = ("run_completed", "run_refused", "run_failed")
PAGE_DPI = 120
QUOTE_PREFIX = 60
HIGHLIGHT = (1.0, 0.541, 0.0)        # --fiber-orange #FF8A00

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


def result_payload(result: RunResult) -> dict:
    """Full run result as JSON (events are stored separately in the events table)."""
    def dump(model):
        return model.model_dump(mode="json") if model is not None else None
    return {"report": dump(result.report), "markdown": result.markdown, "findings": dump(result.findings),
            "scope": dump(result.scope), "manifest": dump(result.manifest), "sheet": dump(result.sheet),
            "pack": dump(result.pack), "verification": dump(result.verification), "web": dump(result.web)}


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
    return {role: rc.models[0] for role, rc in (profile.roles.items() if profile else []) if rc.models}


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
    app = FastAPI(title="PRISM API")
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
        return session_or_404(session_id)

    @app.post("/api/sessions/{session_id}/runs")
    def start_run(session_id: str, body: RunIn | None = None):
        return {"run_id": launch(session_or_404(session_id), bool(body and body.deep), bool(body and body.web))}

    def launch(session: dict, deep: bool = False, web_on: bool = False) -> str:
        """Start a background run with the session's enquiry and stored chat facts and preferences."""
        session_id = session["id"]
        text = store.enquiry_text(session_id)
        if not text:
            raise HTTPException(422, "session has no enquiry")
        case_id = session["case_id"]
        title = next((c.title for c in cases() if c.case_id == case_id), "") if case_id else session["title"]
        enquiry = Enquiry(case_id=case_id or "ADHOC", title=title, text=text, sha256=sha256_text(text),
                          origin="case_file" if case_id else "ui")
        chat_facts, preferences = store.chat_state(session_id)
        run_id, _ = store.create_run(session_id, new_id())
        threading.Thread(target=_execute, args=(run_id, session_id, enquiry, chat_facts, preferences, deep, web_on),
                         daemon=True, name=f"run-{run_id}").start()
        return run_id

    def _execute(run_id: str, session_id: str, enquiry: Enquiry, chat_facts: list[str], preferences: list[str],
                 deep: bool, web_on: bool = False) -> None:
        held: list[dict] = []          # terminal events are stored after the report, so clients can fetch it
        last_stage: list[str | None] = [None]

        def emit(event: dict) -> None:
            if event.get("type") == "stage_started":
                last_stage[0] = event.get("stage")
            event = {**event, "run_id": run_id}
            if event.get("type") in TERMINAL:
                held.append(event)
            else:
                store.add_event(run_id, event)

        try:
            pipeline = pipeline_factory(deep, emit, web=True) if web_on else pipeline_factory(deep, emit)
            result = pipeline.run(enquiry, chat_facts, preferences)
            store.finish_run(run_id, result_payload(result))
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
        except Exception as exc:  # noqa: BLE001 - any failure is reported to the UI as run_failed
            store.fail_run(run_id, f"{type(exc).__name__}: {exc}")
            store.add_event(run_id, {"type": "run_failed", "run_id": run_id, "ts": time.time(),
                                     "stage": last_stage[0], "payload": {"error": f"{type(exc).__name__}: {exc}"}})

    @app.get("/api/runs/{run_id}/events")
    async def run_events(run_id: str):
        run_or_404(run_id)

        async def stream():
            seq = -1
            while True:
                batch = await asyncio.to_thread(store.events, run_id, seq)
                for event in batch:
                    seq = event["seq"]
                    yield {"data": json.dumps(event, ensure_ascii=False)}
                    if event["type"] in TERMINAL:
                        return
                if not batch:
                    run = await asyncio.to_thread(store.run, run_id)
                    if run["status"] != "running" and not await asyncio.to_thread(store.events, run_id, seq):
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

    @app.get("/api/runs/{run_id}/report")
    def run_report(run_id: str):
        _, result = finished(run_id)
        if result["report"] is None:
            return JSONResponse(status_code=422, content={"refused": True, "scope": result["scope"],
                                                          "markdown": result["markdown"]})
        return result["report"] | {"findings": result["findings"], "scope": result["scope"]}

    @app.get("/api/runs/{run_id}/report.md")
    def run_report_md(run_id: str):
        _, result = finished(run_id)
        return Response(result["markdown"], media_type="text/markdown; charset=utf-8")

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

    @app.post("/api/sessions/{session_id}/messages")
    def post_message(session_id: str, body: MessageIn):
        session = session_or_404(session_id)
        if not body.text.strip():
            raise HTTPException(422, "text is required")
        gw = chat_gateway()
        if not retriever:
            retriever.append(Retriever(kb, gw))
        try:
            return handle_message(session, body.text, store=store, kb=kb, gateway=gw, retriever=retriever[0],
                                  start_run=lambda: launch(session, last_deep(session), last_flag(session, "web")),
                                  web=web if last_flag(session, "web") else None)
        except LLMUnavailable as exc:
            raise HTTPException(503, str(exc)) from exc

    @app.get("/api/sessions/{session_id}/diff")
    def report_diff(session_id: str, from_: int | None = Query(None, alias="from"), to: int | None = None):
        session = session_or_404(session_id)
        versions = [r["version"] for r in session["reports"]]
        if not versions:
            raise HTTPException(404, "session has no reports")
        to = versions[-1] if to is None else to
        from_ = max((v for v in versions if v < to), default=to) if from_ is None else from_
        return diff(report_at(session, from_), report_at(session, to))

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
