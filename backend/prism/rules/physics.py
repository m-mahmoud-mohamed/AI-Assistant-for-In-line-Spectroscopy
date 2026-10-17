"""Physics checks: fiber transmission window vs. method range (S02 p.6), unit conventions."""
from __future__ import annotations

import re

from prism.kb.loader import KnowledgeBase
from prism.rules.base import RuleContext, rule
from prism.schemas import Asset, Finding, PremiseVerdict, Severity


def fiber_family_of(asset: Asset, kb: KnowledgeBase) -> str | None:
    if asset.fiber_family in kb.fibers:
        return asset.fiber_family
    text = asset.description.lower()
    aliases = sorted(((a, fid) for fid, names in kb.lexicon.get("fibers", {}).items() if fid in kb.fibers
                      for a in names), key=lambda x: len(x[0]), reverse=True)
    for alias, fid in aliases:
        if re.search(rf"(?<![\w-]){re.escape(alias)}(?![\w-])", text):
            return fid
    return None


@rule("R-FIBER-WINDOW")
def fiber_window(ctx: RuleContext) -> list[Finding]:
    out = []
    reuse = [i for i, p in enumerate(ctx.sheet.premises) if p.type == "reuse_asset"]
    premise_index = reuse[0] if reuse else None
    for asset in ctx.sheet.existing_assets:
        if asset.kind != "fiber":
            continue
        fam = fiber_family_of(asset, ctx.kb)
        if fam is None:
            out.append(Finding(
                rule_id="R-FIBER-WINDOW", severity=Severity.premise if reuse else Severity.warning,
                message=f"The fiber type of '{asset.description}' is not stated, so it cannot be checked "
                        "against the wavelength range of the intended method.",
                evidence_ids=["S02-p06-visnir-silica", "S02-p06-pir"], premise_index=premise_index,
                premise_verdict=PremiseVerdict.UNVERIFIABLE if reuse else None,
                question="Which fiber type is the existing cable (for example VIS-NIR silica, chalcogenide or "
                         "polycrystalline infrared)?", question_impact="PRIMARY_METHOD_CHANGE",
                slots_read=["existing_assets"]))
            continue
        fiber = ctx.kb.fibers[fam]
        frange = ctx.kb.fiber_range(fam)
        for m in sorted(ctx.methods_intended()):
            mrange = ctx.kb.method_range(m)
            coverage = mrange.coverage_by(frange)
            ids = [fiber["card"], *ctx.kb.methods[m]["range_cards"]]
            data = {"method": m, "fiber_family": fam}
            if coverage == 0.0:
                out.append(Finding(
                    rule_id="R-FIBER-WINDOW", severity=Severity.blocking, evidence_ids=ids, data=data,
                    message=f"{fiber['name']} transmits {frange.label()}, which does not overlap the nominal "
                            f"{m} range {mrange.label()}; this fiber cannot carry {m} light.",
                    premise_index=premise_index,
                    premise_verdict=PremiseVerdict.CONTRADICTED if reuse else None, slots_read=["existing_assets"]))
            elif coverage < 0.95:
                out.append(Finding(
                    rule_id="R-FIBER-WINDOW", severity=Severity.warning, evidence_ids=ids, data=data,
                    message=f"{fiber['name']} ({frange.label()}) covers only part of the nominal {m} range "
                            f"{mrange.label()}; whether it covers the bands needed must be checked on spectra.",
                    premise_index=premise_index,
                    premise_verdict=PremiseVerdict.UNVERIFIABLE if reuse else None, slots_read=["existing_assets"]))
    return out


_UNIT_NOTES = {
    "Raman": ("State the laser excitation wavelength separately from the Raman shift in cm⁻¹.",
              ["S01-p11-raman-shift"]),
    "MIR": ("Give mid-IR ranges in cm⁻¹ with the µm equivalent (4000–400 cm⁻¹ = 2.5–25 µm).",
            ["S01-p09-mir-range"]),
}


@rule("R-UNITS")
def units(ctx: RuleContext) -> list[Finding]:
    return [Finding(rule_id="R-UNITS", severity=Severity.info, message=msg, evidence_ids=cards, data={"method": m})
            for m, (msg, cards) in _UNIT_NOTES.items() if m in ctx.methods_intended()]
