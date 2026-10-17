"""Process rules: link length, hot/fouling interfaces, aqueous media, viability, method combinations."""
from __future__ import annotations

from prism.rules.base import RuleContext, rule
from prism.schemas import Finding, Severity

_HOT_WORDS = ("hot", "temperature", "melt", "foul", "build-up", "build up", "deposit", "pressure", "corros")


@rule("R-LINK-LENGTH")
def link_length(ctx: RuleContext) -> list[Finding]:
    if ctx.sheet.distance.value not in ("adjacent_room", "remote"):
        return []
    return [Finding(
        rule_id="R-LINK-LENGTH", severity=Severity.warning, slots_read=["distance"],
        evidence_ids=["S02-p07-silica-cables", "S02-p09-short-ir-cables", "S02-p18-analyzer-vs-sensors"],
        message="Long fiber links are documented for silica (VIS-NIR) cables; the mid-IR fiber examples in the "
                "materials are short cables. A remote mid-IR set-up needs its link confirmed with AFS, or an "
                "alternative: an analyzer near the process, a NIR or Raman method on silica, or a local sensor.",
        question="What is the cable route and length between the measurement point and the analyzer location, "
                 "and could an analyzer or sensor be installed near the process?",
        question_impact="PRIMARY_METHOD_CHANGE")]


@rule("R-HOT-FOULING")
def hot_fouling(ctx: RuleContext) -> list[Finding]:
    pc = ctx.sheet.process_conditions
    text = f"{pc.value} {pc.quote or ''}".lower()
    if not pc.stated or not any(w in text for w in _HOT_WORDS):
        return []
    return [Finding(
        rule_id="R-HOT-FOULING", severity=Severity.warning, slots_read=["process_conditions"],
        evidence_ids=["S02-p14-api-extrusion", "S02-p13-water-petroleum"],
        message="Hot or fouling interfaces have documented ATR and reflection applications, but temperature, "
                "pressure and cleaning ratings of a specific probe must be confirmed with AFS.",
        question="What temperature, pressure, build-up and cleaning conditions does the probe face?",
        question_impact="TECHNIQUE_CHANGE")]


@rule("R-AQUEOUS")
def aqueous(ctx: RuleContext) -> list[Finding]:
    return [Finding(
        rule_id="R-AQUEOUS", severity=Severity.info, stream_id=s.id, slots_read=["streams.matrix", "domain"],
        evidence_ids=["S01-p16-raman-aqueous"],
        message="In aqueous media Raman is attractive because water interferes less than in infrared methods.")
        for s in ctx.sheet.streams
        if s.matrix.value == "liquid" and ctx.sheet.domain in ("bioprocess", "dairy_food")]


@rule("R-OD-NOT-VIABILITY")
def od_not_viability(ctx: RuleContext) -> list[Finding]:
    return [Finding(
        rule_id="R-OD-NOT-VIABILITY", severity=Severity.warning, stream_id=s.id, slots_read=["streams.targets"],
        evidence_ids=["S01-p16-uvvis-biomass"],
        message="Optical density or turbidity correlates with cell density; it is not a measure of viable cells.")
        for s in ctx.sheet.streams
        if any(w in t.name.lower() for t in s.targets for w in ("viab", "living", "live cell"))]


@rule("R-COMBINATION")
def combination(ctx: RuleContext) -> list[Finding]:
    owned = {a.method for a in ctx.sheet.existing_assets if a.method}
    proposed = {p.method for p in ctx.sheet.premises if p.method and p.type == "method_preselected"}
    if not ((owned and proposed - owned) or len(proposed) >= 2):
        return []
    return [Finding(
        rule_id="R-COMBINATION", severity=Severity.warning, slots_read=["premises", "existing_assets"],
        evidence_ids=["S01-p08-same-spot", "S01-p08-synchronisation", "S01-p09-variable-quality",
                      "S01-p07-nir-raman-coating", "S04-p01-combi-probe"],
        message="Assess each method on its own first; any gain from combining methods is a hypothesis to test. "
                "Combined measurements must sample the same spot at aligned times, and fused data need "
                "dedicated processing.")]
