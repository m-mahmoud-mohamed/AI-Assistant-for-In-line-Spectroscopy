import pytest
from pydantic import ValidationError

from prism.schemas import (
    Card,
    ClaimType,
    DecisionStatus,
    Fact,
    RecRole,
    RequirementsSheet,
    Stream,
    is_looser,
    iter_segments,
    stricter,
)
from tests.factories import make_sheet, minimal_body


def test_stricter_status_order():
    P, I, O = (DecisionStatus.PROVISIONAL, DecisionStatus.INSUFFICIENT_INFORMATION,
               DecisionStatus.OUTSIDE_SUPPORTED_SCOPE)
    assert stricter(P, I) == I
    assert stricter(O, I) == O
    assert is_looser(P, I) and not is_looser(O, I)


def test_fact_is_stated_only_with_quote():
    assert not Fact(value="liquid").stated
    assert Fact(value="liquid", quote="a liquid stream").stated
    assert not Fact().stated


def test_stream_rejects_unknown_matrix_value():
    with pytest.raises(ValidationError):
        Stream(matrix=Fact(value="plasma", quote="plasma"))


def test_sheet_needs_at_least_one_stream():
    with pytest.raises(ValidationError):
        RequirementsSheet(streams=[])


def test_unknown_slots_lists_global_and_stream_slots():
    sheet = RequirementsSheet(streams=[Stream()])
    slots = sheet.unknown_slots()
    assert "distance" in slots and "streams.s1.matrix" in slots and "streams.s1.targets" in slots


def test_with_value_returns_hypothetical_copy():
    sheet = make_sheet(matrix="liquid", optics="unknown")
    other = sheet.with_value("streams.s1.optics", "clear")
    assert other.streams[0].optics.value == "clear"
    assert sheet.streams[0].optics.value == "unknown"
    assert sheet.with_value("distance", "remote").distance.value == "remote"


def test_report_body_requires_recommendation_and_concept():
    body = minimal_body()
    assert body.recommendations[0].role == RecRole.PRIMARY
    with pytest.raises(ValidationError):
        minimal_body(recommendations=[])
    with pytest.raises(ValidationError):
        minimal_body(measurement_concept=[])


def test_iter_segments_yields_paths():
    paths = [p for p, _ in iter_segments(minimal_body())]
    assert "direct_answer.text[0]" in paths
    assert "recommendations[0].rationale[0]" in paths


def test_card_citation_formats():
    base = dict(quote="q", claim="c", scope="method_general")
    assert Card(id="a", source="S01", page=10, **base).citation() == "S01 p.10"
    assert Card(id="b", source="TABLE", page=6, **base).citation() == "S01 Table 1 (p.6)"
    ext = Card(id="c", source="EXT", page=0, url="https://x.org", retrieved_at="2026-10-17",
               **{**base, "scope": "external"})
    assert ext.citation() == "[EXT] https://x.org"


def test_segment_claim_type_is_enum():
    body = minimal_body()
    assert body.recommendations[0].rationale[0].claim_type == ClaimType.AFS
