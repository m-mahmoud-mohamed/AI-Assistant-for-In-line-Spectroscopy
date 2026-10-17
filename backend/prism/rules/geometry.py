"""Sample type → technique fit (S01 Table 1) and optical state → probe geometry (S01 p.16–18)."""
from __future__ import annotations

from prism.rules.base import RuleContext, rule
from prism.schemas import DecisionStatus, Finding, Severity

MATRIX_TO_SAMPLE = {
    "liquid": {"liquid", "colloidal"},
    "powder": {"powder", "scattering media"},
    "paste": {"paste", "soft"},
    "solid": {"solid", "solid film", "pill"},
    "tissue": {"soft", "solid"},
    "gas": set(),
}
_TABLE_CARDS = ["TABLE-nir_diffuse_reflection_probe", "TABLE-mir_atr_probe", "TABLE-raman_raman_probe"]


def sample_fit(tech: dict, matrix: str) -> float:
    if matrix == "unknown":
        return 1.0
    return 2.0 if set(tech["sample_types"]) & MATRIX_TO_SAMPLE.get(matrix, set()) else 0.0


def optics_fit(tech: dict, optics: str) -> float:
    name = tech["technique"].lower()
    transmissive = "transmission" in name or "transflection" in name
    reflective = "reflection" in name or "surface" in name or "atr" in name
    contact = "atr" in name or tech["method"] in ("Raman", "Fluorescence")
    if optics == "unknown":
        return 1.0
    if optics == "clear":
        return 2.0 if transmissive else 1.0 if contact else 0.5
    if optics in ("opaque", "scattering"):
        return 0.0 if transmissive else 2.0 if reflective else 1.0
    return 1.0  # turbid or variable: geometries must be compared


@rule("R-SAMPLE-GEOMETRY")
def sample_geometry(ctx: RuleContext) -> list[Finding]:
    out = []
    for s in ctx.sheet.streams:
        m = s.matrix.value
        if m == "unknown":
            continue
        if not any(t["in_line"] and sample_fit(t, m) > 0 for t in ctx.kb.techniques.values()):
            out.append(Finding(
                rule_id="R-SAMPLE-GEOMETRY", severity=Severity.gate, status=DecisionStatus.OUTSIDE_SUPPORTED_SCOPE,
                message=f"No in-line measurement technique in S01 Table 1 covers a {m} sample.",
                evidence_ids=_TABLE_CARDS, stream_id=s.id, slots_read=[f"streams.{s.id}.matrix"]))
    return out


@rule("R-OPTICAL-STATE")
def optical_state(ctx: RuleContext) -> list[Finding]:
    out = []
    for s in ctx.sheet.streams:
        o = s.optics.value
        if s.matrix.value not in ("liquid", "unknown") or o == "unknown":
            continue
        slots = [f"streams.{s.id}.optics"]
        if o in ("turbid", "variable"):
            out.append(Finding(
                rule_id="R-OPTICAL-STATE", severity=Severity.warning, stream_id=s.id, slots_read=slots,
                message="The optical character of this stream varies. Transmission suits clear liquids but fails "
                        "when the product becomes too thick, so transmission/transflection and reflection or ATR "
                        "geometries should be compared on representative samples.",
                evidence_ids=["S01-p18-nir-transmission-clear", "S01-p18-transmission-fails-thick",
                              "S01-p18-transflection-combined", "S01-p16-atr-high-od"]))
        elif o == "clear":
            out.append(Finding(
                rule_id="R-OPTICAL-STATE", severity=Severity.info, stream_id=s.id, slots_read=slots,
                message="A clear liquid suits transmission or transflection probes.",
                evidence_ids=["S01-p18-nir-transmission-clear", "S01-p16-transmission-clear"]))
        else:
            out.append(Finding(
                rule_id="R-OPTICAL-STATE", severity=Severity.info, stream_id=s.id, slots_read=slots,
                message="An opaque or strongly scattering liquid suits diffuse reflection or ATR probes; "
                        "transmission is unlikely to work.",
                evidence_ids=["S01-p17-nir-reflection-opaque", "S01-p16-atr-high-od"]))
    return out
