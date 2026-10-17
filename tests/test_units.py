import pytest

from prism.units import Range, convert


def test_mir_wavenumbers_to_micrometres():
    assert Range.from_cm1(4000, 400) == Range(2.5, 25.0)


def test_silica_does_not_overlap_mid_infrared():
    silica = Range.from_nm(350, 2400)
    assert silica.overlap(Range.from_cm1(4000, 400)) is None


def test_chalcogenide_partially_covers_mid_infrared():
    mir = Range.from_cm1(4000, 400)
    cir = Range.from_nm(1100, 6500)
    assert mir.overlap(cir) == Range(2.5, 6.5)
    assert mir.coverage_by(cir) == pytest.approx(4.0 / 22.5)


def test_convert_units():
    assert convert(4000, "cm-1", "um") == pytest.approx(2.5)
    assert convert(1940, "nm", "cm-1") == pytest.approx(5154.64, rel=1e-4)
    assert convert(2.5, "µm", "nm") == pytest.approx(2500)


def test_invalid_range_rejected():
    with pytest.raises(ValueError):
        Range(3.0, 1.0)
