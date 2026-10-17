from prism.rules.base import RuleContext
from prism.rules.geometry import optical_state, optics_fit, sample_fit, sample_geometry
from prism.rules.physics import fiber_family_of, fiber_window, units
from prism.schemas import Asset, DecisionStatus, Premise, PremiseVerdict, Severity
from tests.factories import make_sheet


def test_sample_and_optics_fit(kb):
    nir_dr = kb.techniques["nir_diffuse_reflection_probe"]
    nir_tt = kb.techniques["nir_transmission_or_transflection_probe"]
    assert sample_fit(nir_dr, "powder") == 2.0 and sample_fit(nir_tt, "powder") == 0.0
    assert sample_fit(nir_dr, "unknown") == 1.0
    assert optics_fit(nir_tt, "clear") == 2.0 and optics_fit(nir_tt, "opaque") == 0.0
    assert optics_fit(nir_dr, "opaque") == 2.0


def test_gas_has_no_in_line_technique(kb):
    findings = sample_geometry(RuleContext(make_sheet(matrix="gas"), kb))
    assert findings[0].severity == Severity.gate
    assert findings[0].status == DecisionStatus.OUTSIDE_SUPPORTED_SCOPE


def test_variable_optics_warns_to_compare_geometries(kb):
    f = optical_state(RuleContext(make_sheet(matrix="liquid", optics="variable"), kb))[0]
    assert f.severity == Severity.warning and "S01-p18-transmission-fails-thick" in f.evidence_ids


def test_fiber_family_from_description(kb):
    assert fiber_family_of(Asset(kind="fiber", description="old quartz fibre cable", quote="q"), kb) == "visnir_silica"
    assert fiber_family_of(Asset(kind="fiber", description="UV silica patch cord", quote="q"), kb) == "uvvis_silica"
    assert fiber_family_of(Asset(kind="fiber", description="a cable", quote="q"), kb) is None


def _reuse(method: str, description: str):
    return make_sheet(premises=(Premise(type="reuse_asset", text="reuse the existing cable", method=method,
                                        quote="reuse"),),
                      assets=(Asset(kind="fiber", description=description, quote="cable"),))


def test_silica_cannot_carry_mid_infrared(kb):
    f = fiber_window(RuleContext(_reuse("MIR", "silica fiber cable"), kb))[0]
    assert f.severity == Severity.blocking and f.premise_verdict == PremiseVerdict.CONTRADICTED
    assert f.data == {"method": "MIR", "fiber_family": "visnir_silica"}
    assert {"S02-p06-visnir-silica", "S01-p09-mir-range"} <= set(f.evidence_ids)


def test_partial_coverage_is_unverifiable(kb):
    f = fiber_window(RuleContext(_reuse("MIR", "chalcogenide fiber"), kb))[0]
    assert f.severity == Severity.warning and f.premise_verdict == PremiseVerdict.UNVERIFIABLE


def test_unknown_fiber_family_asks_question(kb):
    f = fiber_window(RuleContext(_reuse("MIR", "an existing cable"), kb))[0]
    assert f.premise_verdict == PremiseVerdict.UNVERIFIABLE and f.question


def test_units_note_for_raman(kb):
    sheet = make_sheet(premises=(Premise(type="method_preselected", text="use Raman", method="Raman", quote="Raman"),))
    assert units(RuleContext(sheet, kb))[0].evidence_ids == ["S01-p11-raman-shift"]
