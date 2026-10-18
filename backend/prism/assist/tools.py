"""Assistant tools (docs/ASSISTANT_ARCHITECTURE.md §B.3): the spectroscopy calculators and the read-only domain tools.

    calculators    convert, raman_absolute, fiber_window, loss_budget, atr_depth: code only, unit-tested with the values
                   of docs/ARCHITECTURE_V2.md §3.5. Every result carries provenance `computed` and a `text` that states
                   its numbers with their units, so the answer verifier accepts them when the agent quotes them.
    Tool           one tool: the dotted name the UI shows (`kb.search`), the wire name the model calls (`kb_search`;
                   provider function names allow no dots), its JSON schema, the `tool_started` label and the
                   `tool_finished` summary
    domain_tools   kb.search, kb.card, engine.explain, calc.*, report.section, report.diff

The interaction tools (ask_user, update_plan, request_approval, suggest_next) and the assessment tools (assess.*), which
pause the turn or start report runs, are built by the harness (prism/assist/harness.py).
"""
from __future__ import annotations

import math
import re
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass, field

from prism.chat import REPORT_SECTIONS, card_summary, check_fiber_window, diff, explain_rule, report_section
from prism.kb.loader import KnowledgeBase
from prism.schemas import AssessmentReport, RuleFindings
from prism.stages.checks import numbers
from prism.units import UNIT_ALIASES
from prism.units import convert as convert_value

COMPUTED = "computed"
UNIT_DECIMALS = {"nm": 1, "um": 3, "cm-1": 1}
UNIT_NAMES = {"nm": "nm", "um": "µm", "cm-1": "cm-1"}
CRYSTALS = {"diamond": 2.4, "ZnSe": 2.4, "Ge": 4.0, "Si": 3.4}       # ATR crystal refractive indices (mid-IR)
SAMPLE_N, ATR_ANGLE = 1.5, 45.0                                    # textbook defaults, named as assumptions
SCORE_PARTS = {"fit": "sample fit", "optics": "optical access", "evidence": "AFS evidence", "link": "fiber link"}
MAX_CARDS = 6


def _num(x: float, decimals: int = 3) -> str:
    """A number as a scientist writes it: no trailing zeros, no exponent."""
    text = f"{float(x):.{decimals}f}".rstrip("0").rstrip(".")
    return text if text not in ("-0", "") else "0"


def _computed(**out) -> dict:
    return {**out, "provenance": COMPUTED}


# ---------------------------------------------------------------- calculators

def convert(value: float, from_unit: str, to_unit: str) -> dict:
    """nm, µm and cm-1 into each other: 785 nm = 12738.9 cm-1."""
    f, t = UNIT_ALIASES.get(str(from_unit).strip()), UNIT_ALIASES.get(str(to_unit).strip())
    if f is None or t is None:
        raise ValueError("supported units: nm, um, cm-1")
    if not math.isfinite(float(value)) or float(value) <= 0:
        raise ValueError("the spectral value must be positive and finite")
    out = round(convert_value(float(value), f, t), UNIT_DECIMALS[t])
    return _computed(value=out, unit=t, text=f"{_num(value)} {UNIT_NAMES[f]} = {_num(out)} {UNIT_NAMES[t]}")


def raman_absolute(shift_cm1: float, excitation_nm: float) -> dict:
    """The absolute wavelength of a Raman band: 1000 cm-1 at 785 nm = 851.9 nm; a negative shift is anti-Stokes."""
    if not all(math.isfinite(float(v)) for v in (shift_cm1, excitation_nm)) or excitation_nm <= 0:
        raise ValueError("the excitation wavelength must be positive")
    absolute = 1e7 / float(excitation_nm) - float(shift_cm1)
    if absolute <= 0:
        raise ValueError("the shift is larger than the excitation wavenumber")
    nm = round(1e7 / absolute, 1)
    side = "Stokes" if shift_cm1 >= 0 else "anti-Stokes"
    return _computed(wavelength_nm=nm, side=side, text=f"a Raman shift of {_num(shift_cm1)} cm-1 at "
                     f"{_num(excitation_nm)} nm excitation lies at {_num(nm)} nm ({side})")


def fiber_window(kb: KnowledgeBase, method: str, fiber_family: str) -> dict:
    """Does a fiber family transmit a method's nominal range? MIR (2.5–25 µm) through silica: no overlap, blocked."""
    out = check_fiber_window(kb, method, fiber_family)
    if "error" in out:
        return out
    m, f = out["method"], out["fiber_family"]
    lo, hi = out["method_range_um"]
    flo, fhi = out["fiber_range_um"]
    name = kb.fibers[f].get("name", f)
    if out["overlap"]:
        olo, ohi = out["overlap_um"]
        verdict = (f"overlap {_num(olo)}–{_num(ohi)} µm, {_num(100 * out['coverage_of_method_range'], 0)} % "
                   f"of the method range")
    else:
        verdict = "no overlap, so this fiber blocks the method"
    return _computed(**out, blocked=not out["overlap"],
                     text=f"{m} ({_num(lo)}–{_num(hi)} µm) through {name} ({_num(flo)}–{_num(fhi)} µm): {verdict}")


def loss_budget(length_m: float, db_per_m: float | None = None, db_per_km: float | None = None) -> dict:
    """One-way fiber attenuation over a link. It needs the attenuation from a datasheet, an AFS card or the client;
    without one it returns status `ask` and never assumes a value."""
    if length_m is None or not math.isfinite(float(length_m)) or float(length_m) <= 0:
        raise ValueError("the fiber length must be positive")
    if db_per_m is None and db_per_km is None:
        return {"status": "ask", "needs": "the fiber's attenuation (dB/m or dB/km) at the working wavelength",
                "text": "No attenuation is known for this fiber: ask for the datasheet value (dB/m or dB/km) at the "
                        "working wavelength before stating a loss."}
    per_m = float(db_per_m) if db_per_m is not None else float(db_per_km) / 1000.0
    if not math.isfinite(per_m) or per_m < 0:
        raise ValueError("the attenuation cannot be negative")
    loss = round(float(length_m) * per_m, 2)
    kept = round(100.0 * 10 ** (-loss / 10.0), 1)
    given = f"{_num(db_per_m)} dB/m" if db_per_m is not None else f"{_num(db_per_km)} dB/km"
    return _computed(status="ok", length_m=float(length_m), db_per_m=per_m, loss_db=loss, transmitted_percent=kept,
                     text=f"{_num(length_m)} m at {given}: {_num(loss, 2)} dB one-way loss, about {_num(kept, 1)} % "
                          f"of the light transmitted")


def atr_depth(n1: float, n2: float = SAMPLE_N, angle_deg: float = ATR_ANGLE, wavenumber_cm1: float | None = None,
              wavelength_um: float | None = None) -> dict:
    """ATR penetration depth dp = λ / (2π n1 √(sin²θ − (n2/n1)²)): diamond or ZnSe (2.4), sample 1.5, 45°,
    1000 cm-1 → 2.01 µm."""
    if not all(math.isfinite(float(v)) and float(v) > 0 for v in (n1, n2, angle_deg)) or angle_deg >= 90:
        raise ValueError("indices must be positive and incidence must be between zero and ninety degrees")
    if wavelength_um is not None and (not math.isfinite(float(wavelength_um)) or wavelength_um <= 0):
        raise ValueError("the wavelength must be positive and finite")
    if wavenumber_cm1 is not None and (not math.isfinite(float(wavenumber_cm1)) or wavenumber_cm1 <= 0):
        raise ValueError("the wavenumber must be positive and finite")
    if wavelength_um is None:
        if not wavenumber_cm1 or wavenumber_cm1 <= 0:
            raise ValueError("give a positive wavenumber (cm-1) or wavelength (um)")
        wavelength_um = 1e4 / float(wavenumber_cm1)
    s = math.sin(math.radians(float(angle_deg))) ** 2 - (float(n2) / float(n1)) ** 2
    if s <= 0:
        raise ValueError("no total internal reflection: the angle is below the critical angle")
    dp = round(float(wavelength_um) / (2 * math.pi * float(n1) * math.sqrt(s)), 2)
    at = f"{_num(wavenumber_cm1)} cm-1" if wavenumber_cm1 else f"{_num(wavelength_um)} µm"
    return _computed(depth_um=dp, text=f"ATR penetration depth at {at} (crystal n1 {_num(n1)}, sample n2 {_num(n2)}, "
                                       f"{_num(angle_deg)}° incidence) = {_num(dp, 2)} µm")


# ---------------------------------------------------------------- tools

def _summary(result: dict) -> str:
    if isinstance(result, dict) and result.get("error"):
        return str(result["error"])
    if isinstance(result, dict) and result.get("text"):
        return str(result["text"])
    return "done"


@dataclass
class Tool:
    name: str                                   # dotted, as the UI shows it: kb.search
    description: str
    parameters: dict
    fn: Callable[[dict], dict]
    label: Callable[[dict], str]                # `tool_started` label for these arguments
    summary: Callable[[dict], str] = _summary   # `tool_finished` summary of a result
    approval: str | None = None                 # an action the scientist approves first (web.search, assess.write)
    interaction: bool = False                   # shown as a card (plan, question, approval), not as a tool row

    @property
    def wire(self) -> str:
        return self.name.replace(".", "_")

    def spec(self) -> dict:
        return {"type": "function",
                "function": {"name": self.wire, "description": self.description, "parameters": self.parameters}}


def obj(props: dict, required: list[str] | None = None) -> dict:
    return {"type": "object", "properties": props, "required": list(required or [])}


@dataclass
class SessionView:
    """What the domain tools read about the session. The harness updates it during a turn (a new verdict, a new
    report version), and the tools read it at call time."""
    report: AssessmentReport | None = None
    findings: RuleFindings | None = None
    versions: list[int] = field(default_factory=list)
    report_at: Callable[[int], AssessmentReport | None] = lambda v: None
    sources: list[str] = field(default_factory=list)       # texts that may supply a calculator's inputs


def _grounded_number(value: float | None, sources: list[str]) -> bool:
    """A calculator input must come from the scientist, the enquiry or a card, never from the model's memory."""
    if value is None:
        return True
    pool = set().union(*(numbers(s) for s in sources)) if sources else set()
    return _num(value, 6) in pool


def explain(kb: KnowledgeBase, findings: RuleFindings | None, target: str) -> dict:
    """Why a rule fired, or why a candidate scored as it did (its four score parts, blocks and cards)."""
    t = " ".join(str(target).split())
    rule = next((r for r in kb.rules_meta if r.lower() == t.lower()), None)
    if rule is not None:
        out = explain_rule(kb, rule)
        if findings is not None:
            out["fired"] = [{"severity": f.severity.value, "message": f.message, "stream_id": f.stream_id}
                            for f in findings.findings if f.rule_id == rule]
        return out
    if findings is None:
        return {"error": "there is no assessment to explain yet", "rules": sorted(kb.rules_meta)}
    key = t.lower()

    def names(c) -> set[str]:
        return {c.key.lower(), c.method.lower(), c.technique.lower(), c.technique_id.lower(),
                f"{c.method} {c.technique}".lower()}

    hits = [c for c in findings.candidates if key in names(c)] or [
        c for c in findings.candidates if key and key in f"{c.method} {c.technique}".lower()]
    if not hits:
        return {"error": f"no rule or candidate called {t!r}", "rules": sorted(kb.rules_meta),
                "candidates": sorted({f"{c.method} {c.technique}" for c in findings.candidates})}
    rows = []
    for c in hits[:4]:
        open_ = [x.key for x in findings.top(c.stream_id, len(findings.candidates))]
        rows.append({"method": c.method, "technique": c.technique, "stream_id": c.stream_id,
                     "score": round(c.score, 2), "parts": {SCORE_PARTS[p]: round(getattr(c, p), 2) for p in SCORE_PARTS},
                     "blocked": c.blocked, "rank": open_.index(c.key) + 1 if c.key in open_ else None,
                     "reasons": list(c.reasons)})
    ids = [i for i in dict.fromkeys(i for c in hits for i in c.evidence_ids) if i in kb.cards][:MAX_CARDS]
    return {"status": findings.status.value, "candidates": rows, "cards": [card_summary(kb, i) for i in ids],
            "note": "score = sample fit + optical access + AFS evidence + fiber link; rank 1 is the engine's first "
                    "choice for that stream; a blocked candidate is excluded by a rule"}


def domain_tools(kb: KnowledgeBase, retriever, view: SessionView) -> list[Tool]:
    """The read-only tools: knowledge base, engine explanations, calculators and the report."""
    methods, fibers = sorted(kb.methods), sorted(kb.fibers)
    units = ["nm", "um", "cm-1"]

    def search(a: dict) -> dict:
        k = max(1, min(int(a.get("k") or 5), 10))
        return {"cards": [card_summary(kb, c) for c in retriever.search(str(a["query"]), k=k)]}

    def card(a: dict) -> dict:
        cid = str(a["card_id"]).strip().strip("[]")
        return card_summary(kb, cid) if cid in kb.cards else {"error": f"unknown card {cid!r}"}

    def loss(a: dict) -> dict:
        given = {k: a.get(k) for k in ("length_m", "db_per_m", "db_per_km")}
        missing = [k for k, v in given.items() if not _grounded_number(v, view.sources)]
        for key, unit in (("db_per_m", "m"), ("db_per_km", "km")):
            value = given[key]
            if value is not None and not any(re.search(
                    rf"(?<![\w.]){re.escape(_num(value, 6))}\s*dB\s*(?:/|per\s+)\s*{unit}\b", source, re.IGNORECASE)
                    for source in view.sources):
                missing.append(key)
        if "length_m" in missing:
            return {"status": "ask", "error": "the fiber length is not stated by the client or the scientist; ask for it"}
        if missing:
            given = {**given, "db_per_m": None, "db_per_km": None}
        out = loss_budget(given["length_m"], given["db_per_m"], given["db_per_km"])
        return {**out, "note": "the attenuation given is not in any source, so it was not used"} if missing else out

    def section(a: dict) -> dict:
        version = a.get("version")
        rep = view.report_at(int(version)) if version else view.report
        return report_section(rep, str(a["name"]))

    def compare(a: dict) -> dict:
        if len(view.versions) < 2:
            return {"error": "the session has only one report version"}
        to = int(a.get("to") or view.versions[-1])
        frm = int(a.get("from") or max((v for v in view.versions if v < to), default=to))
        old, new = view.report_at(frm), view.report_at(to)
        if old is None or new is None:
            return {"error": f"unknown version; the session has {view.versions}"}
        return {"from": frm, "to": to, **diff(old, new)}

    def fiber(a: dict) -> dict:
        return fiber_window(kb, str(a["method"]), str(a["fiber_family"]))

    def atr(a: dict) -> dict:
        crystal = a.get("crystal")
        n1 = a.get("n1") if a.get("n1") is not None else CRYSTALS.get(str(crystal), None)
        if n1 is None:
            return {"error": f"give n1 or a crystal: {sorted(CRYSTALS)}"}
        assumed = [k for k in ("n2", "angle_deg") if a.get(k) is None]
        out = atr_depth(float(n1), float(a.get("n2", SAMPLE_N)), float(a.get("angle_deg", ATR_ANGLE)),
                        a.get("wavenumber_cm1"), a.get("wavelength_um"))
        return {**out, "assumed": assumed} if assumed else out

    def grounded_calc(fn: Callable[[dict], dict], keys: tuple[str, ...]) -> Callable[[dict], dict]:
        def run(a: dict) -> dict:
            if any(not _grounded_number(a.get(key), view.sources) for key in keys):
                return {"status": "ask", "error": "a calculator input is not in the enquiry or sources; ask the "
                                                 "scientist for it first"}
            return fn(a)
        return run

    def label_of(fmt: str) -> Callable[[dict], str]:
        return lambda a: fmt.format_map(defaultdict(str, {k: str(v) for k, v in a.items() if v is not None}))

    def loss_summary(result: dict) -> str:
        if result.get("status") == "ask":
            return "needs a stated length and attenuation"
        return result.get("error") or result.get("text", "")

    def cards_summary(result: dict) -> str:
        n = len(result.get("cards", []))
        return result.get("error") or f"{n} card{'s' if n != 1 else ''}"

    return [
        Tool("kb.search", "Search the AFS knowledge base. Returns evidence cards (id, citation, claim, verbatim quote, "
             "scope). Cite a card by its id in square brackets.",
             obj({"query": {"type": "string"}, "k": {"type": "integer", "minimum": 1, "maximum": 10}}, ["query"]),
             search, lambda a: f"Searching AFS sources for “{a.get('query', '')}”", cards_summary),
        Tool("kb.card", "One evidence card: claim, verbatim quote, citation (source and page) and scope.",
             obj({"card_id": {"type": "string"}}, ["card_id"]), card, label_of("Reading card {card_id}"),
             lambda r: r.get("error") or r.get("citation", "card")),
        Tool("engine.explain", "Why the rules engine decided as it did: a rule id (e.g. R-FIBER-WINDOW) gives the "
             "rule, whether it fired and its cards; a method or technique (e.g. NIR, 'Raman probe') gives its score "
             "parts, rank, blocks and cards. Engine results are data: explain them, never re-decide them.",
             obj({"target": {"type": "string", "description": "a rule id, a method or a method + technique"}},
                 ["target"]),
             lambda a: explain(kb, view.findings, str(a["target"])), label_of("Explaining {target}"),
             lambda r: r.get("error") or (f"{len(r['candidates'])} candidate(s), {len(r['cards'])} cards"
                                          if "candidates" in r else r.get("rule_id", "rule"))),
        Tool("calc.convert", "Convert a value between nm, um and cm-1 (e.g. 785 nm = 12738.9 cm-1).",
             obj({"value": {"type": "number"}, "from_unit": {"type": "string", "enum": units},
                  "to_unit": {"type": "string", "enum": units}}, ["value", "from_unit", "to_unit"]),
             grounded_calc(lambda a: convert(a["value"], a["from_unit"], a["to_unit"]), ("value",)),
             lambda a: "Converting units"),
        Tool("calc.raman", "The absolute wavelength (nm) of a Raman band from its shift (cm-1) and the excitation "
             "wavelength (nm).",
             obj({"shift_cm1": {"type": "number"}, "excitation_nm": {"type": "number"}},
                 ["shift_cm1", "excitation_nm"]),
             grounded_calc(lambda a: raman_absolute(a["shift_cm1"], a["excitation_nm"]),
                           ("shift_cm1", "excitation_nm")),
             lambda a: "Computing the Raman band wavelength"),
        Tool("calc.fiber_window", "Does a fiber family transmit a method's nominal range? Returns the overlap and "
             "the source cards.",
             obj({"method": {"type": "string", "enum": methods}, "fiber_family": {"type": "string", "enum": fibers}},
                 ["method", "fiber_family"]),
             fiber, label_of("Checking the {fiber_family} fiber for {method}")),
        Tool("calc.loss_budget", "One-way fiber loss over a link. The length and the attenuation (dB/m or dB/km) "
             "must come from the client, the scientist or a card; without an attenuation it answers 'ask'.",
             obj({"length_m": {"type": "number"}, "db_per_m": {"type": "number"}, "db_per_km": {"type": "number"}},
                 ["length_m"]),
             loss, lambda a: "Computing the fiber loss budget", loss_summary),
        Tool("calc.atr_depth", "ATR penetration depth (um) for a crystal (diamond, ZnSe, Ge, Si) or its index n1, the "
             "sample index n2 (default 1.5), the angle (default 45°) and a wavenumber (cm-1) or wavelength (um).",
             obj({"crystal": {"type": "string", "enum": sorted(CRYSTALS)}, "n1": {"type": "number"},
                  "n2": {"type": "number"}, "angle_deg": {"type": "number"}, "wavenumber_cm1": {"type": "number"},
                  "wavelength_um": {"type": "number"}}),
             grounded_calc(atr, ("n1", "n2", "angle_deg", "wavenumber_cm1", "wavelength_um")),
             lambda a: "Computing the ATR penetration depth"),
        Tool("report.section", "One section of the current report (or of an earlier version).",
             obj({"name": {"type": "string", "enum": list(REPORT_SECTIONS)},
                  "version": {"type": "integer", "minimum": 1}}, ["name"]),
             section, lambda a: f"Reading the report: {str(a.get('name', '')).replace('_', ' ')}",
             lambda r: r.get("error") or "read"),
        Tool("report.diff", "What changed between two report versions (status, recommendations, questions, risks). "
             "Defaults: the latest version against the one before.",
             obj({"from": {"type": "integer", "minimum": 1}, "to": {"type": "integer", "minimum": 1}}),
             compare, lambda a: "Comparing report versions",
             lambda r: r.get("error") or f"v{r['from']} → v{r['to']}"),
    ]
