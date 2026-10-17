from prism.rules.engine import evaluate
from prism.schemas import Asset, Premise
from prism.stages.normalise import canonical_method, normalise_sheet, scan_terms
from tests.factories import make_sheet


def test_typo_and_german_terms_are_canonicalised(kb):
    found = {(i.term.lower(), i.canonical, i.how) for i in
             scan_terms("We tried NIRS and flourescence; Nahinfrarot looked promising.", kb.lexicon)}
    assert ("nirs", "NIR", "exact") in found
    assert ("flourescence", "Fluorescence", "fuzzy") in found
    assert ("nahinfrarot", "NIR", "exact") in found


def test_short_tokens_are_never_fuzzy_matched(kb):
    assert all(i.how != "fuzzy" for i in scan_terms("The pH and UVB values are logged.", kb.lexicon))


def test_ir_with_atr_context_resolves_to_mir(kb):
    items = scan_terms("An IR probe with an ATR crystal in the reactor.", kb.lexicon)
    ir = next(i for i in normalise_sheet(make_sheet(), "An IR probe with an ATR crystal in the reactor.", kb)
              .interpretations if i.term.lower() == "ir")
    assert any(i.ambiguous for i in items) and ir.canonical == "MIR" and ir.how == "context" and not ir.ambiguous


def test_ambiguous_ir_creates_question(kb):
    text = "We would like to use IR spectroscopy for moisture in a powder."
    sheet = normalise_sheet(make_sheet(matrix="powder", targets=("moisture",)), text, kb)
    assert any(i.ambiguous and i.alternatives == ["NIR", "MIR"] for i in sheet.interpretations)
    assert any(q.slot.startswith("term:") for q in evaluate(sheet, kb).question_seeds)


def test_methods_and_fibers_are_canonicalised(kb):
    sheet = make_sheet(premises=(Premise(type="method_preselected", text="use ft-ir", method="ft-ir", quote="ft-ir"),),
                       assets=(Asset(kind="fiber", description="quartz fibre", quote="quartz fibre"),))
    out = normalise_sheet(sheet, "use ft-ir with our quartz fibre", kb)
    assert out.premises[0].method == "MIR" and out.existing_assets[0].fiber_family == "visnir_silica"
    assert canonical_method("Raman-Spektroskopie", kb.lexicon) == "Raman"
