"""Report export: one document model for the client report, rendered as Markdown, JSON, HTML (the browser-print
fallback) and a real A4 PDF (PyMuPDF's HTML engine, with a running header and footer).

The document is a client document: the original enquiry, the answer, recommendations, methods, spectral ranges,
measurement concept, risks, plan, open questions, what is known and unknown, what changed in this version, numbered
references and a short statement on quality. Internal QA (the check names, verifier paths, run details) only appears
in the optional technical appendix. The user interface strings never do.
"""
from __future__ import annotations

import html
import io
import json
import math
import re
import unicodedata
from dataclasses import asdict, dataclass, field
from datetime import datetime

import fitz

from prism.chat import diff as report_diff
from prism.kb.loader import KnowledgeBase
from prism.schemas import (
    AssessmentReport,
    ClaimType,
    DecisionStatus,
    RecRole,
    RuleFindings,
    Segment,
    SourceRef,
    Verdict,
    iter_segments,
)
from prism.stages.render import fiber_gap_note

STATUS_PHRASE = {DecisionStatus.PROVISIONAL: "Provisional assessment",
                 DecisionStatus.INSUFFICIENT_INFORMATION: "Insufficient information",
                 DecisionStatus.OUTSIDE_SUPPORTED_SCOPE: "Outside the supported scope"}
ROLE_PHRASE = {RecRole.PRIMARY: "Primary", RecRole.COMPARISON: "Comparison", RecRole.CONDITIONAL: "Conditional",
               RecRole.SCREENING: "Screening", RecRole.NOT_RECOMMENDED: "Not recommended"}
SOURCE_TITLES = {
    "S01": "Multispectral Laboratory of Optical Analysis Methods: purpose, methods, and applications",
    "S02": "Process-Control in-line with Spectral Fiber Systems (AFS slides)",
    "S03": "Development and Testing of an LED-Based Near-Infrared Sensor for Human Kidney Tumor Diagnostics (2017)",
    "S04": "Fiber Probe for Simultaneous Mid-Infrared and Fluorescence Spectroscopic Analysis (2021)",
    "S05": "AFS flyer: Test of Customer Process in-situ across the 0.3–16 µm range",
    "TABLE": "AFS method comparison table (S01, Table 1)",
}
SLOT_LABEL = {"targets": "Target", "matrix": "Matrix", "optics": "Optical state", "distance": "Distance to the analyser",
              "use_context": "Use context", "requested_certainty": "Requested certainty",
              "process_conditions": "Process conditions", "concentration_range": "Concentration range",
              "accuracy_and_limits": "Accuracy and limits", "response_time": "Response time",
              "reference_method": "Reference method", "location_access": "Location and access",
              "existing_assets": "Existing equipment", "premises": "Premises", "domain": "Domain"}
MARKERS = {"external": ("†", "external (web) source"), "assumption": ("*", "assumption to be confirmed"),
           "unknown": ("‡", "not known, an open point"), "partial": ("§", "only partly supported by its source")}
GENERIC_RANGE_NOTES = ("the usable range depends", "nominal method range")
PLAN_ELEMENTS = (("samples_and_states", "Samples and states"), ("reference_measurements", "Reference measurements"),
                 ("setup", "Set-up"), ("comparison", "Comparison"), ("validation", "Validation"),
                 ("go_no_go", "Go / no-go"), ("not_demonstrated", "Not demonstrated"))
CHECK_NAMES = {"C-IDS": "Citation ids", "C-FINDINGS": "Rule findings", "C-STATUS": "Decision status",
               "C-SUPPORT": "Claim support", "C-WEB-VERIFIED": "Web sources verified",
               "P-MIN-RECOMMENDATION": "Minimum recommendation", "P-DIRECT-ANSWER": "Direct answer",
               "P-AFS-CITATION": "AFS citation", "P-NO-NUMBERS": "No invented numbers",
               "P-NO-GUARANTEE": "No over-claiming", "P-NO-BAND-PICK": "No band picking",
               "P-NO-SELF-ANSWER": "No self-answered facts", "P-PLAN-COMPLETE": "Complete plan",
               "P-QUESTIONS": "Client questions", "P-LENGTH": "Length limit", "P-SCOPE": "Scope"}
STRUCTURAL = ("P-", "C-IDS", "C-FINDINGS", "C-STATUS", "C-WEB")


def verdict_phrase(verdict: Verdict | str, status: DecisionStatus | str | None = None) -> str:
    """The direct answer's verdict in words. A YES is always a provisional one in this tool: never a bare "Yes"."""
    v = verdict.value if isinstance(verdict, Verdict) else str(verdict)
    return {"YES": "Provisionally feasible", "CONDITIONAL": "Conditionally feasible",
            "NO": "Not feasible as described", "NOT_YET": "Not yet decidable",
            "NOT_APPLICABLE": "No yes/no question"}.get(v, v.replace("_", " ").capitalize())


def slot_label(slot: str) -> str:
    last = slot.split(".")[-1]
    return SLOT_LABEL.get(last, last.replace("_", " ").capitalize())


def plain(text: str) -> str:
    """Snake_case ids that leaked into prose read as a sentence."""
    t = (text or "").strip()
    if re.fullmatch(r"[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+", t):
        t = t.replace("_", " ").lower()
        return t[:1].upper() + t[1:]
    return t


def full_title(title: str, enquiry: str) -> str:
    """The session title is the enquiry's first 60 characters with an ellipsis: print the whole first sentence."""
    t = (title or "").strip()
    stem = t.rstrip("…").rstrip(". ").strip()
    if not t.endswith("…") and not (enquiry and enquiry.startswith(t) and len(t) < len(enquiry) and len(t) <= 60):
        return t or "Assessment report"
    flat = " ".join((enquiry or "").split())
    if flat.startswith(stem) and len(stem) < len(flat):
        m = re.search(r"[.!?](?:\s|$)", flat[len(stem):])
        sentence = flat[:len(stem) + m.start() + 1] if m else flat
        return sentence if len(sentence) <= 220 else sentence[:220].rsplit(" ", 1)[0]
    return stem or "Assessment report"


# ---------------------------------------------------------------- the document model

@dataclass
class Block:
    kind: str                          # h | p | quote | ul | ol | table | box | note | figure
    text: str = ""
    items: list[str] = field(default_factory=list)
    columns: list[str] = field(default_factory=list)
    rows: list[list[str]] = field(default_factory=list)
    widths: list[int] = field(default_factory=list)      # table column shares in percent
    level: int = 2
    svg: str = ""
    title: str = ""


@dataclass
class Section:
    id: str
    title: str
    blocks: list[Block] = field(default_factory=list)


@dataclass
class Document:
    title: str
    version: int
    date: str
    status: str
    meta: list[tuple[str, str]]
    front: list[Block]
    sections: list[Section]
    legend: list[str]
    data: dict = field(default_factory=dict)


@dataclass
class ExportInput:
    report: AssessmentReport
    version: int = 1
    versions: int = 1
    session_id: str = ""
    enquiry: str = ""
    revision: dict = field(default_factory=dict)       # trigger, summary, changed_sections, follow_up_findings
    findings: RuleFindings | None = None
    verification: dict | None = None                   # the stored VerificationReport
    manifest: dict | None = None
    previous: AssessmentReport | None = None
    previous_version: int = 0
    conversation: list[dict] | None = None             # [{role, kind, text}] (the optional appendix)
    kb: KnowledgeBase | None = None
    technical: bool = False


def parse_appendix(value: str | None) -> tuple[bool, bool]:
    """`appendix=conversation,technical` (or `all`) → (conversation, technical)."""
    parts = {p.strip().lower() for p in re.split(r"[,\s]+", value or "") if p.strip()}
    return bool(parts & {"conversation", "all", "true", "1"}), bool(parts & {"technical", "all", "true", "1"})


def _date(iso: str) -> str:
    try:
        d = datetime.fromisoformat(iso)
        return f"{d.day} {d:%B %Y}"
    except ValueError:
        return iso[:10]


class _Cites:
    """Numbered references and the footnote markers a sentence carries."""

    def __init__(self, report: AssessmentReport, partial: set[str]):
        self.index = {s.id: i for i, s in enumerate(report.sources, 1)}
        self.paths = {id(seg): path for path, seg in iter_segments(report)}
        self.partial, self.used = partial, set()

    def refs(self, ids: list[str]) -> str:
        nums = sorted({self.index[i] for i in ids if i in self.index})
        return f"[{', '.join(map(str, nums))}]" if nums else ""

    def sentence(self, seg: Segment) -> str:
        text = seg.text.strip()
        marks = ""
        kind = {ClaimType.EXTERNAL: "external", ClaimType.ASSUMPTION: "assumption",
                ClaimType.UNKNOWN: "unknown"}.get(seg.claim_type)
        if kind:
            marks += MARKERS[kind][0]
            self.used.add(kind)
        if self.paths.get(id(seg)) in self.partial:
            marks += MARKERS["partial"][0]
            self.used.add("partial")
        refs = self.refs(seg.evidence_ids)
        return " ".join(x for x in (text, refs + marks if refs else marks) if x)

    def text(self, segments: list[Segment]) -> str:
        return " ".join(self.sentence(s) for s in segments)


def reference_line(s: SourceRef, kb: KnowledgeBase | None) -> str:
    if s.id.startswith("EXT") or s.url:
        v = s.verification
        site = v.domain if v and v.domain else (s.url or "web")
        extra = f" Retrieved {v.retrieved_at[:10]}." if v and v.retrieved_at else ""
        return f"{site}: “{s.quote.strip()}” {s.url or ''}{extra}".strip()
    code = s.id.split("-")[0]
    title = SOURCE_TITLES.get(code, code)
    page = re.search(r"p\.(\d+)", s.citation)
    where = f", p. {page.group(1)}" if page else ""
    card = kb.cards.get(s.id) if kb is not None else None
    quote = s.quote.strip()
    if code == "TABLE" or "|" in quote:
        # A row of the method table is shown as a sentence, never as its raw cells.
        sentence = (card.claim if card is not None else "") or "; ".join(c.strip() for c in quote.split("|") if c.strip())
        return f"{title}{where}: {sentence.strip()}"
    return f"{title}{where}: “{quote}”"


def _lines_of_plan(cites: _Cites, report: AssessmentReport) -> list[Block]:
    plan = report.feasibility_plan
    blocks = [Block("p", f"**Objective.** {plan.objective}"), Block("ol", items=list(plan.steps))]
    for name, label in PLAN_ELEMENTS:
        segs = getattr(plan, name)
        if segs:
            blocks.append(Block("p", f"**{label}.** {cites.text(segs)}"))
    return blocks


def one_line(text: str, limit: int = 150) -> str:
    """The first sentence of a reason, cut at a clause or word boundary when it is long (the full text is in the
    recommendation's detail)."""
    t = " ".join(text.split())
    m = re.search(r"[.!?](?:\s|$)", t)
    t = t[:m.start() + 1] if m else t
    if len(t) <= limit:
        return t
    cut = max(t.rfind(sep, 0, limit) for sep in (";", ":", ","))
    cut = cut if cut > limit // 2 else t.rfind(" ", 0, limit)
    return t[:cut].rstrip(" ,;:") + " …"


def _candidate_table(inp: ExportInput, cites: _Cites) -> list[Block]:
    report = inp.report
    recs = {(tuple(r.methods), r.technique): r for r in report.recommendations}
    rows, extra = [], []
    seen: set[tuple] = set()
    if inp.findings is not None:
        for c in inp.findings.candidates:
            key = (c.method, c.technique)
            if key in seen:
                continue
            seen.add(key)
            rec = recs.get(((c.method,), c.technique))
            status = ROLE_PHRASE[rec.role] if rec else ("Blocked" if c.blocked else "Considered")
            reasons = [r.strip() for r in c.reasons if r.strip()]
            if rec and rec.rationale:
                reasons = [rec.rationale[0].text.strip()]
            rows.append([c.method, c.technique, status, one_line(reasons[0]) if reasons else "No rule excludes it."])
            if not rec and len(reasons) > 1:
                extra.append(f"**{c.method}, {c.technique}.** " + " ".join(reasons))
    engine = {(c.method, c.technique) for c in inp.findings.candidates} if inp.findings else set()
    for rec in report.recommendations:                       # combinations and screening are not engine candidates
        if len(rec.methods) == 1 and (rec.methods[0], rec.technique) in engine:
            continue
        rows.append([" + ".join(rec.methods), rec.technique, ROLE_PHRASE[rec.role],
                     one_line(rec.rationale[0].text) if rec.rationale else ""])
    rank = {"Primary": 0, "Comparison": 1, "Conditional": 2, "Screening": 3, "Considered": 4, "Blocked": 5,
            "Not recommended": 6}
    rows.sort(key=lambda r: rank.get(r[2], 9))
    blocks = [Block("table", columns=["Method", "Technique", "Status", "Reason"], rows=rows, widths=[13, 27, 14, 46])]
    if extra:
        blocks += [Block("p", "**Further reasons.**"), Block("ul", items=extra)]
    return blocks


def _range_figure(inp: ExportInput) -> str:
    kb, report = inp.kb, inp.report
    if kb is None or not report.spectral_ranges:
        return ""
    bars: list[tuple[str, float, float, str]] = []
    fibers: dict[str, tuple[float, float]] = {}
    for r in report.spectral_ranges:
        if r.method not in kb.methods:
            continue
        rng = kb.method_range(r.method)
        bars.append((r.method, rng.lo_um, rng.hi_um, "method"))
        for fid, f in kb.fibers.items():
            if f.get("name", fid) in r.fiber_family_needed:
                fr = kb.fiber_range(fid)
                fibers[f.get("name", fid)] = (fr.lo_um, fr.hi_um)
    bars += [(name, lo, hi, "fiber") for name, (lo, hi) in fibers.items()]
    if not bars:
        return ""
    return range_svg(bars)


def range_svg(bars: list[tuple[str, float, float, str]], width: int = 640) -> str:
    """Spectral windows of the methods and of the fibers that carry them, on a log wavelength axis (µm)."""
    left, right, row, top = 150, 14, 22, 8
    lo, hi = math.log10(0.18), math.log10(26)
    plot = width - left - right
    x = lambda um: left + (math.log10(um) - lo) / (hi - lo) * plot
    height = top + row * len(bars) + 30
    out = ['<svg xmlns="http://www.w3.org/2000/svg" ' + f'width="{width}" height="{height}" '
           f'viewBox="0 0 {width} {height}" font-family="Helvetica, Arial, sans-serif" font-size="10">']
    for um in (0.2, 0.5, 1, 2, 5, 10, 20):
        out.append(f'<line x1="{x(um):.1f}" y1="{top}" x2="{x(um):.1f}" y2="{top + row * len(bars)}" stroke="#d4d4d8" '
                   f'stroke-width="0.6"/>')
        out.append(f'<text x="{x(um):.1f}" y="{top + row * len(bars) + 12}" text-anchor="middle" fill="#52525b">{um:g}</text>')
    out.append(f'<text x="{left + plot / 2:.1f}" y="{height - 4}" text-anchor="middle" fill="#52525b">wavelength (µm, log scale)</text>')
    for i, (name, a, b, kind) in enumerate(bars):
        y = top + i * row
        colour = "#7c5cd6" if kind == "method" else "#8fb3a8"
        out.append(f'<text x="{left - 8}" y="{y + 13}" text-anchor="end" fill="#18181b">{html.escape(name)}</text>')
        out.append(f'<rect x="{x(a):.1f}" y="{y + 3}" width="{max(2.0, x(b) - x(a)):.1f}" height="13" rx="2" fill="{colour}"/>')
    out.append("</svg>")
    return "".join(out)


def _quality(inp: ExportInput) -> list[Block]:
    report, ver = inp.report, inp.verification or {}
    verdicts = ver.get("verdicts") or []
    counts = {k: sum(1 for v in verdicts if v.get("verdict") == k)
              for k in ("supported", "partial", "unsupported", "scope_exceeded")}
    comp = report.compliance or {}
    structural = {k: v for k, v in comp.items() if k.startswith(STRUCTURAL)}
    cited = sum(1 for _, s in iter_segments(report) if s.evidence_ids)
    parts = [f"{cited} statements in this report cite a source; each was checked against the text of that source."]
    if structural:
        ok = sum(1 for v in structural.values() if v)
        parts.append(f"Format and policy checks: {ok} of {len(structural)} passed.")
    if verdicts:
        judged = len(verdicts)
        bit = f"Evidence support: {counts['supported']} of {judged} judged claims supported"
        if counts["partial"]:
            bit += f", {counts['partial']} only partly supported and marked {MARKERS['partial'][0]}"
        if counts["unsupported"] or counts["scope_exceeded"]:
            bit += f", {counts['unsupported'] + counts['scope_exceeded']} not supported"
        parts.append(bit + ".")
    elif inp.verification is None:
        parts.append("Evidence support was not recorded for this version.")
    if inp.revision.get("trigger"):
        parts.append("Sections carried over from the previous version keep their earlier verification.")
    return [Block("p", " ".join(parts))]


def build(inp: ExportInput) -> Document:
    report, kb = inp.report, inp.kb
    partial = {v["path"] for v in (inp.verification or {}).get("verdicts", []) if v.get("verdict") == "partial"}
    partial |= {i["path"] for i in (inp.verification or {}).get("issues", []) if str(i.get("message", "")).startswith("partial")}
    cites = _Cites(report, partial)
    enquiry = inp.enquiry or ""
    title = full_title(report.title, enquiry)
    streams = {s.id: s.name for s in report.streams}
    verdict = verdict_phrase(report.direct_answer.verdict, report.decision_status)
    status = STATUS_PHRASE[report.decision_status]
    date = _date(report.created_at)
    meta = [("Date", date), ("Report version", f"v{inp.version}" + (f" of {inp.versions}" if inp.versions > 1 else "")),
            ("Status", status), ("Prepared by", "PRISM for Art Fiber Systems (AFS)")]
    front: list[Block] = []
    if enquiry:
        front += [Block("h", "Original enquiry", level=2), Block("quote", enquiry.strip())]
    if report.client_question:
        front += [Block("h", "Client question", level=2), Block("p", " ".join(report.client_question))]
    front += [Block("h", "Direct answer", level=2), Block("p", f"**{verdict}.** {cites.text(report.direct_answer.text)}")]
    lead = next((r for r in report.recommendations if r.role in (RecRole.PRIMARY, RecRole.SCREENING)), None)
    if lead is not None:
        front.append(Block("box", f"{' + '.join(lead.methods)} · {lead.technique} "
                                  f"({ROLE_PHRASE[lead.role].lower()}, evidence {lead.evidence_strength or 'not rated'}). "
                                  "Details in section 1.", title="Key recommendation"))
    sections: list[Section] = []

    def add(sid: str, title_: str, blocks: list[Block]) -> None:
        if blocks:
            sections.append(Section(sid, title_, blocks))

    # 1 recommendations in detail
    recs: list[Block] = []
    for r in report.recommendations:
        applies = ", ".join(streams.get(s, s) for s in r.applies_to)
        recs.append(Block("h", f"{' + '.join(r.methods)} · {r.technique}", level=3))
        recs.append(Block("note", f"{ROLE_PHRASE[r.role]} · evidence {r.evidence_strength or 'not rated'}"
                                  + (f" · applies to {applies}" if len(report.streams) > 1 else "")))
        if r.rationale:
            recs.append(Block("p", cites.text(r.rationale)))
        if r.conditions:
            recs.append(Block("p", "**Conditions.** " + cites.text(r.conditions)))
        if r.limitations:
            recs.append(Block("p", "**Limitations.** " + cites.text(r.limitations)))
    add("recommendations", "Recommendations", recs)
    add("methods", "Methods compared", _candidate_table(inp, cites))
    # 3 spectral ranges and fibers
    rng: list[Block] = []
    figure = _range_figure(inp)
    if figure:
        rng.append(Block("figure", svg=figure, title="Spectral windows of the methods and of the fibers that carry them"))
    rows, seen_notes = [], set()
    for r in report.spectral_ranges:
        notes = []
        for seg in r.caveat:
            key = " ".join(seg.text.lower().split())
            if seg.text.strip() and key not in seen_notes and not key.startswith(GENERIC_RANGE_NOTES):
                seen_notes.add(key)
                notes.append(cites.sentence(seg))
        gap = fiber_gap_note(r.method, kb) if kb is not None else ""
        excitation = f"Excitation {r.excitation_nm:g} nm." if r.excitation_nm else ""
        rows.append([r.method, r.nominal_range, r.fiber_family_needed, " ".join(x for x in (*notes, gap, excitation) if x)])
    if rows:
        rng.append(Block("table", columns=["Method", "Nominal range", "Fiber", "Notes"], rows=rows, widths=[12, 26, 20, 42]))
        rng.append(Block("note", "Nominal ranges only: the usable range depends on the instrument, fiber and probe and is "
                                 "specified for the selected system."))
    add("ranges", "Spectral ranges and fibers", rng)
    # 4 measurement concept
    conc: list[Block] = []
    if report.measurement_concept:
        conc.append(Block("table", columns=["Stream", "Probe geometry", "Location", "Fiber link"], widths=[14, 30, 26, 30],
                          rows=[[streams.get(m.stream_id, m.stream_id), plain(m.probe_geometry), plain(m.location),
                                 plain(m.fiber_link)] for m in report.measurement_concept]))
        notes = [cites.text(m.notes) for m in report.measurement_concept if m.notes]
        if notes:
            conc.append(Block("ul", items=notes))
    add("concept", "Measurement concept", conc)
    # 5 risks and assumptions
    risks = [f"{cites.text(k.risk)} Effect: {plain(k.effect).rstrip('.')}. Mitigation: {plain(k.mitigation).rstrip('.')}."
             for k in report.risks]
    assume = [f"{a.assumption.strip().rstrip('.')} (to confirm with {a.to_confirm_with})." for a in report.assumptions]
    ra: list[Block] = []
    if risks:
        ra += [Block("h", "Risks", level=3), Block("ul", items=risks)]
    if assume:
        ra += [Block("h", "Assumptions", level=3), Block("ul", items=assume)]
    add("risks", "Risks and assumptions", ra)
    add("plan", "Feasibility plan", _lines_of_plan(cites, report))
    # 7 questions: one line each, with why it matters (the interactive option effects stay in the app)
    qs = sorted(report.clarification_questions, key=lambda q: q.priority)
    add("questions", "Open questions for the client",
        [Block("ol", items=[f"{q.question.strip()} Why it matters: {q.why_it_matters.strip()}" if q.why_it_matters.strip()
                            else q.question.strip() for q in qs])] if qs else [])
    # 8 known and unknown
    known = report.requirements.stated_facts
    unknown = report.requirements.key_unknowns
    ku: list[Block] = []
    if known:
        ku.append(Block("table", columns=["Topic", "Value", "Client's words"], widths=[24, 22, 54], rows=[
            [slot_label(f.slot), plain(f.value).replace("_", " "),
             "Confirmed by the scientist in conversation" if f.provenance == "confirmed" else f"“{f.quote}”"]
            for f in known]))
    if unknown:
        ku += [Block("h", "Still unknown", level=3),
               Block("ul", items=[f"{slot_label(u.slot)}: {u.why_it_matters.strip()}" for u in unknown])]
    add("known", "What the client told us and what is still unknown", ku)
    # 9 changes in this version
    if inp.version > 1 or inp.revision.get("trigger"):
        ch: list[Block] = []
        if inp.revision.get("summary"):
            ch.append(Block("p", inp.revision["summary"]))
        if inp.revision.get("trigger"):
            ch.append(Block("p", f"**Follow-up that led to this version.** “{inp.revision['trigger']}”"))
        findings = inp.revision.get("follow_up_findings") or []
        if findings:
            ch += [Block("p", "**New information recorded.**"), Block("ul", items=[str(f) for f in findings])]
        if inp.previous is not None:
            d = report_diff(inp.previous, report)
            lines = []
            if d["status"]:
                lines.append(f"Status: {STATUS_PHRASE[DecisionStatus(d['status']['from'])]} → "
                             f"{STATUS_PHRASE[DecisionStatus(d['status']['to'])]}.")
            for r in d["recommendations"]["added"]:
                lines.append(f"Recommendation added: {' + '.join(r['methods'])} · {r['technique']}.")
            for r in d["recommendations"]["removed"]:
                lines.append(f"Recommendation removed: {' + '.join(r['methods'])} · {r['technique']}.")
            lines += [f"Question settled: {q}" for q in d["questions"]["resolved"]]
            lines += [f"New question: {q}" for q in d["questions"]["new"]]
            if lines:
                ch += [Block("p", f"**Compared with v{inp.previous_version}.**"), Block("ul", items=lines)]
        add("changes", "Changes in this version", ch)
    # references and quality
    refs = [reference_line(s, kb) for s in report.sources]
    add("references", "References", [Block("ol", items=refs)] if refs else [])
    add("quality", "Quality and traceability", _quality(inp))
    if inp.conversation is not None:
        add("conversation", "Appendix A. Conversation",
            [Block("p", f"**{'Scientist' if m['role'] == 'user' else 'PRISM'}.** {m['text']}") for m in inp.conversation]
            or [Block("p", "There was no conversation beyond the enquiry in this session.")])
    if inp.technical:
        add("technical", "Appendix B. Technical details", _technical(inp))
    legend = [f"{MARKERS[k][0]} {MARKERS[k][1]}" for k in ("external", "assumption", "unknown", "partial") if k in cites.used]
    data = _data(inp, title, verdict, status, date)
    return Document(title, inp.version, date, status, meta, front, sections, legend, data)


# ---------------------------------------------------------------- what changed between two versions

PARTS = (("decision_status", "Decision status", "answer"), ("direct_answer", "Direct answer", "answer"),
         ("premise_checks", "Premise checks", "answer"), ("recommendations", "Recommendations", "answer"),
         ("measurement_concept", "Measurement concept", "concept"), ("spectral_ranges", "Spectral ranges", "concept"),
         ("risks", "Risks", "concept"), ("assumptions", "Assumptions", "concept"),
         ("clarification_questions", "Open questions", "plan"), ("feasibility_plan", "Feasibility plan", "plan"),
         ("decision_basis", "Decision basis", "plan"), ("requirements", "What the client told us", "requirements"))


def part_lines(report: AssessmentReport, name: str) -> list[str]:
    """One report part as plain lines (for the change view): its sentences, without citations or markers."""
    t = lambda segs: " ".join(s.text.strip() for s in segs)
    if name == "decision_status":
        return [STATUS_PHRASE[report.decision_status]]
    if name == "direct_answer":
        return [verdict_phrase(report.direct_answer.verdict, report.decision_status) + ". " + t(report.direct_answer.text)]
    if name == "premise_checks":
        return [f"{p.premise.strip()}: {p.verdict.value.lower()}. {t(p.explanation)}" for p in report.premise_checks]
    if name == "recommendations":
        return [f"{' + '.join(r.methods)} · {r.technique} ({ROLE_PHRASE[r.role].lower()}, evidence "
                f"{r.evidence_strength or 'not rated'}). {t(r.rationale)}" for r in report.recommendations]
    if name == "measurement_concept":
        return [f"{m.stream_id}: {plain(m.probe_geometry)}; {plain(m.location)}; {plain(m.fiber_link)}"
                for m in report.measurement_concept]
    if name == "spectral_ranges":
        return [f"{r.method}: {r.nominal_range}; fiber {r.fiber_family_needed}" for r in report.spectral_ranges]
    if name == "risks":
        return [f"{t(k.risk)} Effect: {plain(k.effect)}. Mitigation: {plain(k.mitigation)}." for k in report.risks]
    if name == "assumptions":
        return [f"{a.assumption} (to confirm with {a.to_confirm_with})" for a in report.assumptions]
    if name == "clarification_questions":
        return [q.question for q in sorted(report.clarification_questions, key=lambda q: q.priority)]
    if name == "feasibility_plan":
        plan = report.feasibility_plan
        return [f"Objective: {plan.objective}", *plan.steps,
                *[f"{label}: {t(getattr(plan, key))}" for key, label in PLAN_ELEMENTS if getattr(plan, key)]]
    if name == "decision_basis":
        return [t(report.decision_basis)]
    return [*(f"{slot_label(f.slot)}: {plain(f.value)}" for f in report.requirements.stated_facts),
            *(f"Unknown: {slot_label(u.slot)}" for u in report.requirements.key_unknowns)]


def section_changes(a: AssessmentReport, b: AssessmentReport) -> list[dict]:
    """Field-level changes from version a to version b: for each changed part the lines added and removed."""
    out = []
    for name, label, section in PARTS:
        before, after = part_lines(a, name), part_lines(b, name)
        if before != after:
            out.append({"field": name, "label": label, "section": section,
                        "added": [x for x in after if x not in before], "removed": [x for x in before if x not in after]})
    return out


def _technical(inp: ExportInput) -> list[Block]:
    report, man = inp.report, inp.manifest or {}
    rows = [["Session", inp.session_id], ["Run", report.run_id], ["Report version", f"v{inp.version}"],
            ["Created", report.created_at], ["Knowledge base", report.kb_version], ["Profile", report.profile],
            ["Input SHA-256", report.input_sha256]]
    rows += [[f"Model ({role})", m] for role, m in report.model_ids.items()]
    if man.get("git_commit"):
        rows.append(["Code revision", man["git_commit"]])
    blocks = [Block("table", columns=["Item", "Value"], rows=rows, widths=[30, 70])]
    if report.compliance:
        blocks += [Block("h", "Checks", level=3), Block("table", columns=["Check", "Result"], widths=[70, 30], rows=[
            [CHECK_NAMES.get(k, k), "passed" if v else "failed"] for k, v in report.compliance.items()])]
    issues = (inp.verification or {}).get("issues") or []
    if issues:
        blocks += [Block("h", "Verifier findings", level=3), Block("table", columns=["Check", "Where", "Finding"],
                   widths=[22, 28, 50], rows=[[CHECK_NAMES.get(i["check_id"], i["check_id"]), i.get("path", ""),
                                               i.get("message", "")] for i in issues])]
    if man.get("timings"):
        blocks += [Block("h", "Pipeline timings", level=3), Block("table", columns=["Stage", "Seconds"], widths=[70, 30],
                   rows=[[k, f"{v:g}"] for k, v in man["timings"].items()])]
    if inp.findings is not None:
        blocks += [Block("h", "Engine scores", level=3), Block("table", columns=["Method", "Technique", "Fit", "Optics",
                   "Evidence", "Link", "Total"], widths=[12, 32, 11, 11, 12, 11, 11], rows=[
                       [c.method, c.technique, f"{c.fit:g}", f"{c.optics:g}", f"{c.evidence:g}", f"{c.link:g}",
                        f"{c.score:g}"] for c in inp.findings.candidates])]
    return blocks


def _data(inp: ExportInput, title: str, verdict: str, status: str, date: str) -> dict:
    """The machine-readable export: the same content in the same order, plus the full report."""
    report = inp.report
    return {"format": "prism.report/1", "title": title,
            "meta": {"session_id": inp.session_id, "run_id": report.run_id, "version": inp.version,
                     "versions": inp.versions, "date": date, "created_at": report.created_at,
                     "status": report.decision_status.value, "status_label": status, "profile": report.profile,
                     "kb_version": report.kb_version, "models": report.model_ids},
            "original_enquiry": inp.enquiry, "client_question": report.client_question,
            "direct_answer": {"verdict": report.direct_answer.verdict.value, "verdict_label": verdict},
            "version_info": {"version": inp.version, "trigger": inp.revision.get("trigger", ""),
                             "summary": inp.revision.get("summary", ""),
                             "changed_sections": inp.revision.get("changed_sections", []),
                             "follow_up_findings": inp.revision.get("follow_up_findings", [])},
            "references": [{"number": i, "id": s.id, "citation": s.citation, "text": reference_line(s, inp.kb),
                            "quote": s.quote, "url": s.url} for i, s in enumerate(report.sources, 1)],
            "report": report.model_dump(mode="json")}


# ---------------------------------------------------------------- Markdown

def render_markdown(doc: Document, inp: ExportInput | None = None) -> str:
    by = dict(doc.meta).get("Prepared by", "")
    out = [f"# {doc.title}", "", f"{doc.date} · Report v{doc.version} · {doc.status} · {by}", ""]
    if inp is not None and inp.session_id:
        out += [f"_Session {inp.session_id} · run {inp.report.run_id} · profile {inp.report.profile}_", ""]
    for b in doc.front:
        out += _block_md(b)
    for n, s in enumerate(doc.sections, 1):
        label = s.title if s.id in ("references", "quality", "conversation", "technical") else f"{n}. {s.title}"
        out += [f"## {label}", ""]
        for b in s.blocks:
            out += _block_md(b)
    if doc.legend:
        out += ["---", "Markers: " + "; ".join(doc.legend) + ".", ""]
    return "\n".join(out).rstrip() + "\n"


def _cell(text: str) -> str:
    return text.replace("|", "/").replace("\n", " ")


def _block_md(b: Block) -> list[str]:
    if b.kind == "h":
        return [f"{'#' * (b.level + 1)} {b.text}", ""] if b.level <= 2 else [f"**{b.text}**", ""]
    if b.kind in ("p", "note"):
        return [b.text if b.kind == "p" else f"_{b.text}_", ""]
    if b.kind == "quote":
        return [*(f"> {line}" if line else ">" for line in b.text.splitlines()), ""]
    if b.kind == "box":
        return [f"> **{b.title}.** {b.text}", ""]
    if b.kind == "ul":
        return [*(f"- {i}" for i in b.items), ""]
    if b.kind == "ol":
        return [*(f"{n}. {i}" for n, i in enumerate(b.items, 1)), ""]
    if b.kind == "table":
        return ["| " + " | ".join(b.columns) + " |", "| " + " | ".join("---" for _ in b.columns) + " |",
                *("| " + " | ".join(_cell(c) for c in row) + " |" for row in b.rows), ""]
    return []


# ---------------------------------------------------------------- HTML (the print document)

CSS = """
html{background:#ffffff}
body{font-family:Helvetica,Arial,sans-serif;font-size:9.6pt;line-height:1.38;color:#18181b;background:#ffffff;margin:0}
h1{font-size:19pt;line-height:1.2;margin:0 0 5pt 0;color:#18181b}
h2{font-size:12.5pt;margin:15pt 0 4pt 0;padding-bottom:2pt;border-bottom:1px solid #a1a1aa;color:#18181b}
h3{font-size:10.6pt;margin:9pt 0 2pt 0;color:#18181b}
p{margin:0 0 5pt 0}
.meta{color:#52525b;font-size:9pt;margin:0 0 8pt 0}
.note{color:#52525b;font-size:8.8pt;margin:0 0 3pt 0}
blockquote{margin:3pt 0 7pt 0;padding:4pt 0 2pt 9pt;border-left:3px solid #a1a1aa;color:#3f3f46}
blockquote p{margin:0 0 4pt 0}
.box{border:1px solid #7c5cd6;padding:6pt 8pt;margin:6pt 0}
.box b{color:#18181b}
ul,ol{margin:2pt 0 6pt 0;padding-left:16pt}
li{margin:0 0 3pt 0}
table{width:100%;border-collapse:collapse;margin:3pt 0 8pt 0;font-size:8.8pt}
th{text-align:left;padding:3pt 4pt;border-bottom:1.2px solid #71717a;font-weight:bold;vertical-align:bottom}
td{padding:3pt 4pt;border-bottom:1px solid #e4e4e7;vertical-align:top}
.sp{padding:0;border:0;font-size:2pt;line-height:2pt}
tr{page-break-inside:avoid}
.legend{color:#52525b;font-size:8.4pt;border-top:1px solid #d4d4d8;margin-top:10pt;padding-top:4pt}
.fig{margin:4pt 0 8pt 0}
.fig p{color:#52525b;font-size:8.4pt;margin:1pt 0 0 0}
"""

BROWSER_CSS = """
@page{size:A4;margin:18mm}
@media screen{body{max-width:174mm;margin:0 auto;padding:12mm 0}}
@media print{h2,h3{break-after:avoid;page-break-after:avoid}
 tr,li,blockquote,.box,.fig,table.keep{break-inside:avoid;page-break-inside:avoid}
 thead{display:table-header-group}
 *{color-scheme:light;-webkit-print-color-adjust:exact;print-color-adjust:exact}}
"""


def _md_inline(text: str) -> str:
    return re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", html.escape(text, quote=False))


CONTENT_PT = 493          # the text width of an A4 page between its margins, in points
PT_PER_NBSP = 0.56        # width of a no-break space at 2 pt, as the PDF engine sets it


def _spacer_row(widths: list[int]) -> str:
    """The PDF engine sizes table columns from their content only. A first row of invisible no-break spaces gives
    each column the width the layout asks for."""
    room = CONTENT_PT - 7 * len(widths)
    return "<tr>" + "".join(f'<td class="sp">{"&#160;" * max(1, int(room * w / 100 / PT_PER_NBSP))}</td>'
                            for w in widths) + "</tr>"


def _block_html(b: Block, figure_src: str | None, pdf: bool = False) -> str:
    if b.kind == "h":
        return f"<h{b.level}>{_md_inline(b.text)}</h{b.level}>"
    if b.kind == "p":
        return f"<p>{_md_inline(b.text)}</p>"
    if b.kind == "note":
        return f'<p class="note">{_md_inline(b.text)}</p>'
    if b.kind == "quote":
        return "<blockquote>" + "".join(f"<p>{_md_inline(line)}</p>" for line in b.text.splitlines() if line.strip()) + "</blockquote>"
    if b.kind == "box":
        return f'<div class="box"><b>{html.escape(b.title)}.</b> {_md_inline(b.text)}</div>'
    if b.kind in ("ul", "ol"):
        return f"<{b.kind}>" + "".join(f"<li>{_md_inline(i)}</li>" for i in b.items) + f"</{b.kind}>"
    if b.kind == "table":
        widths = b.widths or [100 // max(1, len(b.columns))] * len(b.columns)
        head = "".join(f'<th width="{w}%">{html.escape(c)}</th>' for c, w in zip(b.columns, widths, strict=False))
        body = "".join("<tr>" + "".join(f"<td>{_md_inline(c)}</td>" for c in row) + "</tr>" for row in b.rows)
        keep = ' class="keep"' if len(b.rows) <= 8 else ""
        return f'<table width="100%"{keep}>{_spacer_row(widths) if pdf else ""}<tr>{head}</tr>{body}</table>'
    if b.kind == "figure":
        inner = f'<img src="{figure_src}" width="640"/>' if figure_src else b.svg
        return f'<div class="fig">{inner}<p>{html.escape(b.title)}</p></div>'
    return ""


def render_html(doc: Document, *, standalone: bool = True, figure_src: str | None = None, browser: bool = True,
                pdf: bool = False) -> str:
    """The print document. `figure_src` names an image file instead of inlining the SVG (the PDF engine's way)."""
    by = html.escape(dict(doc.meta).get("Prepared by", ""))
    parts = [f"<h1>{html.escape(doc.title)}</h1>",
             f'<p class="meta">{html.escape(doc.date)} · Report v{doc.version} · {html.escape(doc.status)} · {by}</p>']
    parts += [_block_html(b, figure_src, pdf) for b in doc.front]
    for n, s in enumerate(doc.sections, 1):
        label = s.title if s.id in ("references", "quality", "conversation", "technical") else f"{n} {s.title}"
        parts.append(f"<h2>{html.escape(label)}</h2>")
        parts += [_block_html(b, figure_src, pdf) for b in s.blocks]
    if doc.legend:
        parts.append(f'<div class="legend">Markers: {html.escape("; ".join(doc.legend))}.</div>')
    body = "\n".join(parts)
    if not standalone:
        return f"<html><head><style>{CSS}</style></head><body>{body}</body></html>"
    css = CSS + (BROWSER_CSS if browser else "")
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" '
            f'content="width=device-width,initial-scale=1"><title>{html.escape(doc.title)}</title>'
            f"<style>{css}</style></head><body>{body}</body></html>")


# ---------------------------------------------------------------- PDF

PAGE_MARGINS = (51, 54, 51, 56)      # left, top, right, bottom in points (about 18 mm, a little more room for the footer)


def _latin(text: str) -> str:
    return unicodedata.normalize("NFKD", text).encode("latin-1", "ignore").decode("latin-1")


def render_pdf(doc: Document) -> bytes:
    """A4 PDF: the print document laid out by PyMuPDF's HTML engine, then a running header and a page footer."""
    figure = next((b.svg for s in [Section("", "", doc.front), *doc.sections] for b in s.blocks if b.kind == "figure"), "")
    archive = fitz.Archive()
    if figure:
        archive.add(figure.encode(), "spectral.svg")
    story = fitz.Story(render_html(doc, standalone=False, figure_src="spectral.svg" if figure else None, pdf=True),
                       archive=archive)
    mediabox = fitz.paper_rect("a4")
    where = mediabox + (PAGE_MARGINS[0], PAGE_MARGINS[1], -PAGE_MARGINS[2], -PAGE_MARGINS[3])
    target = io.BytesIO()
    writer = fitz.DocumentWriter(target)
    more = 1
    while more:
        device = writer.begin_page(mediabox)
        more, _ = story.place(where)
        story.draw(device)
        writer.end_page()
    writer.close()
    pdf = fitz.open("pdf", target.getvalue())
    total = len(pdf)
    grey = (0.32, 0.32, 0.36)
    right = f"Report v{doc.version}"
    for number, page in enumerate(pdf, 1):
        rect = page.rect
        left_x, right_x = PAGE_MARGINS[0], rect.width - PAGE_MARGINS[2]
        if number > 1:                       # the title is on page 1; later pages carry a running header
            room = right_x - left_x - fitz.get_text_length(right, "helv", 8) - 14
            text = _latin(f"PRISM · {doc.title}")
            if fitz.get_text_length(text, "helv", 8) > room:
                while fitz.get_text_length(text + "...", "helv", 8) > room and len(text) > 10:
                    text = text[:-1]
                text = text.rstrip() + "..."
            page.insert_text((left_x, 36), text, fontname="helv", fontsize=8, color=grey)
            page.insert_text((right_x - fitz.get_text_length(right, "helv", 8), 36), right, fontname="helv", fontsize=8,
                             color=grey)
            page.draw_line((left_x, 41), (right_x, 41), color=(0.8, 0.8, 0.83), width=0.5)
        foot = f"Page {number} of {total}"
        page.insert_text((left_x, rect.height - 30), _latin(doc.date), fontname="helv", fontsize=8, color=grey)
        page.insert_text((right_x - fitz.get_text_length(foot, "helv", 8), rect.height - 30), foot, fontname="helv",
                         fontsize=8, color=grey)
    pdf.set_metadata({"title": doc.title, "author": "PRISM", "creator": "PRISM", "producer": "PRISM"})
    return pdf.tobytes(deflate=True)


def render_doc(doc: Document) -> dict:
    """The document as JSON blocks: what the app prints (the browser's print dialog) from the same model."""
    def blocks(items: list[Block]) -> list[dict]:
        return [asdict(b) for b in items]
    return {"title": doc.title, "version": doc.version, "date": doc.date, "status": doc.status,
            "prepared_by": dict(doc.meta).get("Prepared by", ""), "front": blocks(doc.front),
            "sections": [{"id": s.id, "title": s.title, "blocks": blocks(s.blocks)} for s in doc.sections],
            "legend": doc.legend}


def render_json(doc: Document) -> str:
    sections = [{"id": s.id, "title": s.title, "markdown": "\n".join(line for b in s.blocks for line in _block_md(b)).strip()}
                for s in doc.sections]
    return json.dumps({**doc.data, "sections": sections}, ensure_ascii=False, indent=2)
