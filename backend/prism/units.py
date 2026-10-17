"""Spectral unit conversions and wavelength ranges. Canonical unit: micrometres (µm)."""
from __future__ import annotations

from dataclasses import dataclass


def nm_to_um(nm: float) -> float:
    return nm / 1000.0


def um_to_nm(um: float) -> float:
    return um * 1000.0


def cm1_to_um(cm1: float) -> float:
    if cm1 <= 0:
        raise ValueError("wavenumber must be positive")
    return 10000.0 / cm1


def um_to_cm1(um: float) -> float:
    if um <= 0:
        raise ValueError("wavelength must be positive")
    return 10000.0 / um


UNIT_ALIASES = {
    "nm": "nm",
    "um": "um",
    "µm": "um",
    "μm": "um",
    "micron": "um",
    "microns": "um",
    "cm-1": "cm-1",
    "cm^-1": "cm-1",
    "cm⁻¹": "cm-1",
    "1/cm": "cm-1",
}
_TO_UM = {"nm": nm_to_um, "um": lambda x: x, "cm-1": cm1_to_um}
_FROM_UM = {"nm": um_to_nm, "um": lambda x: x, "cm-1": um_to_cm1}


def convert(value: float, from_unit: str, to_unit: str) -> float:
    f, t = UNIT_ALIASES[from_unit.strip()], UNIT_ALIASES[to_unit.strip()]
    return _FROM_UM[t](_TO_UM[f](value))


@dataclass(frozen=True)
class Range:
    lo_um: float
    hi_um: float

    def __post_init__(self) -> None:
        if not (0 < self.lo_um < self.hi_um):
            raise ValueError(f"invalid range {self.lo_um}-{self.hi_um} µm")

    @classmethod
    def from_nm(cls, a: float, b: float) -> Range:
        return cls(nm_to_um(min(a, b)), nm_to_um(max(a, b)))

    @classmethod
    def from_cm1(cls, a: float, b: float) -> Range:
        return cls(cm1_to_um(max(a, b)), cm1_to_um(min(a, b)))

    def overlap(self, other: Range) -> Range | None:
        lo, hi = max(self.lo_um, other.lo_um), min(self.hi_um, other.hi_um)
        return Range(lo, hi) if lo < hi else None

    def coverage_by(self, other: Range) -> float:
        """Fraction of this range (linear in µm) that `other` covers."""
        ov = self.overlap(other)
        return 0.0 if ov is None else (ov.hi_um - ov.lo_um) / (self.hi_um - self.lo_um)

    def as_cm1(self) -> tuple[float, float]:
        return (um_to_cm1(self.hi_um), um_to_cm1(self.lo_um))

    def label(self) -> str:
        return f"{self.lo_um:g}–{self.hi_um:g} µm"
