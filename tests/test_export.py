"""Report exports: Markdown, JSON, the print HTML and the A4 PDF are built from one document model; the enquiry,
version and numbered references are in, UI strings and internal QA are out. Fake models only."""
import json
import re
import unicodedata

import fitz
import pytest
from fastapi.testclient import TestClient

from prism import export
from prism.api import create_app
from prism.schemas import AssessmentReport, DecisionStatus, Verdict
from prism.stages.render import fiber_gap_note, fibers_for
from prism.store import Store
from tests.test_api import MAT, fake_factory, sse_events, wait_report
from tests.test_orchestrator import TEXT

UI_STRINGS = ("Use as follow-up", "more in Methods", "Method detail", "Ranges as text", "hover a score",
              "Shade is relative", "Engine preview", "No deductions recorded", "Open in app", "Copy ")
INTERNAL = ("feasibility_plan.", "recommendations[", "clarification_questions[", "premise_checks[", "SHA-256",
            "prompt hash", "C-IDS", "P-LENGTH", "stage_started")
LONG_ENQUIRY = ("We run a continuous dairy line and need to follow the fat content of the milk stream in-line, "
                "next to the pipe, without sampling. Which probe should we test first? Fat is usually 3.5 %.")


@pytest.fixture
def client(kb, tmp_path):
    app = create_app(fake_factory(kb), Store(tmp_path / "prism.db"), kb, materials=MAT)
    with TestClient(app) as c:
        yield c


def make_run(client, text=TEXT, title="Water") -> tuple[str, str]:
    sid = client.post("/api/sessions", json={"text": text, "title": title} if title else {"text": text}).json()["id"]
    run_id = client.post(f"/api/sessions/{sid}/runs", json={}).json()["run_id"]
    sse_events(client, run_id)
    assert wait_report(client, run_id).status_code == 200
    return sid, run_id


def flat(text: str) -> str:
    """Text as a reader sees it (the PDF engine sets ligatures such as ﬀ)."""
    return " ".join(unicodedata.normalize("NFKC", text).split())


# ---------------------------------------------------------------- Markdown and JSON

def test_markdown_has_the_enquiry_version_answer_and_numbered_references(client):
    _, run_id = make_run(client)
    md = client.get(f"/api/runs/{run_id}/report.md").text
    assert md.startswith("# Water") and "Report v1" in md and "Provisional assessment" in md
    assert "## Direct answer" in md or "### Direct answer" in md
    assert "> " + TEXT in md and TEXT.split(".")[1].strip() in md        # the quoted enquiry and the client question
    headings = re.findall(r"^## (.+)$", md, flags=re.MULTILINE)
    order = [h.split(". ", 1)[-1] for h in headings]
    assert order[:4] == ["Recommendations", "Methods compared", "Spectral ranges and fibers", "Measurement concept"]
    assert order.index("Feasibility plan") < order.index("Open questions for the client") < order.index("References")
    assert order[-2:] == ["References", "Quality and traceability"]
    refs = md.split("## References")[1].split("## Quality")[0]
    numbers = re.findall(r"^(\d+)\. ", refs, flags=re.MULTILINE)
    assert numbers == [str(i) for i in range(1, len(numbers) + 1)] and len(numbers) >= 3
    assert "Multispectral Laboratory of Optical Analysis Methods" in refs and "p. " in refs and "“" in refs
    assert " | " not in refs and "S01-p" not in refs                     # no raw table row, no internal card slug
    body = md.split("## References")[0]
    assert re.search(r"\[\d+(?:, \d+)*\]", body)                          # in-text citations use the numbers
    assert not re.search(r"\[S0\d-p", md)


def test_export_has_no_ui_strings_internal_paths_or_scores(client):
    _, run_id = make_run(client)
    for ext in ("md", "html"):
        text = client.get(f"/api/runs/{run_id}/report.{ext}").text
        for s in (*UI_STRINGS, *INTERNAL):
            assert s not in text, (ext, s)
        assert ">Fit<" not in text and "| Fit |" not in text and "Optics" not in text
    report = client.get(f"/api/runs/{run_id}/report").json()
    md = client.get(f"/api/runs/{run_id}/report.md").text
    for q in report["clarification_questions"]:                           # why it matters, never the option effects
        assert q["why_it_matters"] in md
        assert q["decision_it_changes"] not in md or q["decision_it_changes"] == q["why_it_matters"]


def test_appendices_are_off_by_default_and_asked_for_by_name(client):
    _, run_id = make_run(client)
    md = client.get(f"/api/runs/{run_id}/report.md").text
    assert "Appendix" not in md and "Technical details" not in md
    both = client.get(f"/api/runs/{run_id}/report.md", params={"appendix": "conversation,technical"}).text
    assert "Appendix A. Conversation" in both and "Appendix B. Technical details" in both
    assert "Citation ids" in both and "Knowledge base" in both and "SHA-256" not in both.replace("Input SHA-256", "")
    only_conversation = client.get(f"/api/runs/{run_id}/report.md", params={"appendix": "conversation"}).text
    assert "Appendix A" in only_conversation and "Appendix B" not in only_conversation


def test_json_export_carries_the_same_content(client):
    sid, run_id = make_run(client)
    data = json.loads(client.get(f"/api/runs/{run_id}/report.json").content)
    assert data["format"] == "prism.report/1" and data["original_enquiry"] == TEXT
    assert data["meta"]["version"] == 1 and data["meta"]["session_id"] == sid and data["meta"]["status"] == "PROVISIONAL"
    assert data["direct_answer"]["verdict_label"] in ("Provisionally feasible", "Conditionally feasible")
    assert data["version_info"]["version"] == 1
    assert [s["title"] for s in data["sections"]][:2] == ["Recommendations", "Methods compared"]
    assert data["references"][0]["number"] == 1 and data["report"]["run_id"] == run_id


def test_full_title_replaces_the_truncated_session_title(client):
    _, run_id = make_run(client, LONG_ENQUIRY, title=None)
    md = client.get(f"/api/runs/{run_id}/report.md").text
    first = md.splitlines()[0]
    assert "…" not in first and first == "# We run a continuous dairy line and need to follow the fat content of the milk stream in-line, next to the pipe, without sampling."
    assert "> " + LONG_ENQUIRY in md


# ---------------------------------------------------------------- the print document

def test_print_html_is_a_light_a4_document_without_app_chrome(client):
    _, run_id = make_run(client)
    page = client.get(f"/api/runs/{run_id}/report.html")
    html = page.text
    assert page.headers["content-type"].startswith("text/html") and html.startswith("<!doctype html>")
    assert "@page{size:A4;margin:18mm}" in html and "<table" in html and "<svg" in html     # the window chart
    for forbidden in ("<button", "<nav", 'role="tab', "prefers-color-scheme", "dark", "<script", "<a "):
        assert forbidden not in html, forbidden
    assert "break-inside:avoid" in html and "break-after:avoid" in html
    assert re.search(r"body\{[^}]*background:#ffffff", html) and re.search(r"color:#18181b", html)


def test_pdf_is_a_real_a4_document_with_running_header_and_footer(client):
    _, run_id = make_run(client, LONG_ENQUIRY, title=None)
    resp = client.get(f"/api/runs/{run_id}/report.pdf", params={"appendix": "technical"})
    assert resp.status_code == 200 and resp.headers["content-type"] == "application/pdf" and resp.content[:5] == b"%PDF-"
    pdf = fitz.open("pdf", resp.content)
    assert len(pdf) >= 2 and all((round(p.rect.width), round(p.rect.height)) == (595, 842) for p in pdf)
    first, last = flat(pdf[0].get_text()), flat(pdf[-1].get_text())
    assert "We run a continuous dairy line" in first and "Original enquiry" in first and "Report v1" in first
    assert flat(LONG_ENQUIRY) in first and "…" not in first.split("Original enquiry")[0]    # the full title, not cut
    assert f"Page 1 of {len(pdf)}" in first and f"Page {len(pdf)} of {len(pdf)}" in last
    assert "PRISM" in flat(pdf[1].get_text()) and "Report v1" in flat(pdf[1].get_text())      # running header
    text = flat(" ".join(p.get_text() for p in pdf))
    for s in (*UI_STRINGS, *INTERNAL[:3], "localhost", "http://"):
        assert s not in text, s
    assert "Recommendations" in text and "References" in text and "Appendix B. Technical details" in text
    assert pdf.metadata["title"].startswith("We run a continuous dairy line")


def test_pdf_pages_are_not_left_nearly_empty_and_rows_do_not_split(client):
    _, run_id = make_run(client)
    pdf = fitz.open("pdf", client.get(f"/api/runs/{run_id}/report.pdf").content)
    for number, page in enumerate(pdf, 1):
        blocks = [b for b in page.get_text("blocks") if b[1] > 60 and b[3] < 790]
        used = max((b[3] for b in blocks), default=0)
        if number < len(pdf):
            assert used > 400, f"page {number} ends at {used:.0f} pt"          # no page forced shut half way
        for b in blocks:                                                         # nothing is clipped at the margins
            assert b[0] >= 48 and b[2] <= 548


def test_pdf_of_a_selected_version_and_the_version_parameter(client):
    _, run_id = make_run(client)
    pdf = fitz.open("pdf", client.get(f"/api/runs/{run_id}/report.pdf", params={"version": 1}).content)
    assert "Report v1" in flat(pdf[0].get_text())
    assert client.get(f"/api/runs/{run_id}/report.pdf", params={"version": 4}).status_code == 404
    assert client.get("/api/runs/nope/report.pdf").status_code == 404


# ---------------------------------------------------------------- the content rules

def test_a_provisional_yes_is_never_a_bare_yes():
    assert export.verdict_phrase(Verdict.YES, DecisionStatus.PROVISIONAL) == "Provisionally feasible"
    assert export.verdict_phrase("CONDITIONAL") == "Conditionally feasible"
    assert export.verdict_phrase(Verdict.NO) == "Not feasible as described"
    assert export.verdict_phrase(Verdict.NOT_APPLICABLE) == "No yes/no question"
    assert all(export.verdict_phrase(v).lower() != "yes" for v in Verdict)


def test_title_is_whole_and_one_line_reasons_are_cut_at_a_boundary():
    assert export.full_title("We run a continuous dairy line and need to follow the…", LONG_ENQUIRY).endswith("without sampling.")
    assert export.full_title("Dairy line fat", "whatever") == "Dairy line fat"
    long = "Transmission suits clear liquids, but the optical path is too long for this product; further text follows here"
    cut = export.one_line(long, 60)
    assert cut.endswith("…") and len(cut) <= 64 and " " + cut.split()[-2] in " " + long


def test_a_table_row_card_reads_as_a_sentence_and_web_sources_carry_their_url(kb):
    row = next(c for c in kb.cards.values() if c.source == "TABLE")
    from prism.schemas import SourceRef
    ref = SourceRef(id=row.id, citation=row.citation(), quote=row.quote, scope=row.scope)
    line = export.reference_line(ref, kb)
    assert "|" not in line and line.startswith("AFS method comparison table") and row.claim.strip() in line
    web = SourceRef(id="EXT-abc", citation="[EXT] https://doi.org/10.1/x", quote="A verbatim line.", scope=row.scope,
                    url="https://doi.org/10.1/x")
    assert "https://doi.org/10.1/x" in export.reference_line(web, kb) and "“A verbatim line.”" in export.reference_line(web, kb)


def test_quality_paragraph_states_structural_and_evidence_results_separately(client, kb):
    _, run_id = make_run(client)
    stored = client.get(f"/api/runs/{run_id}/report").json()
    report = AssessmentReport.model_validate({k: v for k, v in stored.items() if k in AssessmentReport.model_fields})
    verdicts = [{"path": "recommendations[0].rationale[0]", "verdict": "partial", "reason": "partly"},
                {"path": "recommendations[1].rationale[0]", "verdict": "supported", "reason": ""}]
    doc = export.build(export.ExportInput(report=report, enquiry=TEXT, kb=kb, verification={"verdicts": verdicts}))
    quality = next(s for s in doc.sections if s.id == "quality").blocks[0].text
    assert "Format and policy checks:" in quality and "passed" in quality
    assert "Evidence support: 1 of 2 judged claims supported, 1 only partly supported and marked §" in quality
    text = " ".join(b.text for s in doc.sections for b in s.blocks)
    assert "§" in text and "§ only partly supported by its source" in doc.legend
    assert "16/16" not in quality


def test_fibers_for_a_method_a_single_silica_family_covers_names_silica_only(kb):
    assert [fid for fid, _ in fibers_for("NIR", kb)] == ["visnir_silica"]
    assert {fid for fid, _ in fibers_for("MIR", kb)} == {"pir", "hwg"}              # nothing covers it: the best halves
    assert "carry the range up to 2400 nm" in fiber_gap_note("NIR", kb) and fiber_gap_note("Raman", kb) == ""


def test_the_spectral_window_chart_is_drawn_into_the_pdf(client):
    _, run_id = make_run(client)
    page = fitz.open("pdf", client.get(f"/api/runs/{run_id}/report.pdf").content)[1]
    assert page.get_images() or page.get_drawings()
    assert "Spectral windows" in flat(page.get_text())
