"""Bounded, page-preserving extraction of untrusted imported documents. No OCR or macros."""
from __future__ import annotations

import io
import re
import zipfile
from pathlib import PurePosixPath

import fitz
from docx import Document

from prism.sources.models import MAX_FILE_BYTES, MAX_TEXT_CHARS
from prism.web.fetch import html_to_text

MIMES = {".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
         ".txt": "text/plain", ".md": "text/markdown", ".html": "text/html", ".htm": "text/html"}


def safe_path(name: str) -> str:
    name = name.replace("\\", "/")
    parts = name.split("/")
    if (not name or len(name) > 1024 or name.startswith("/") or len(parts) > 64
            or any(p in ("", ".", "..") or ":" in p or "\x00" in p for p in parts)):
        raise ValueError("Invalid relative path; absolute paths and traversal are not allowed")
    return "/".join(re.sub(r"[^\w. ()-]", "_", p)[:150] for p in parts)


def validate_file(name: str, content: bytes) -> tuple[str, str]:
    path = safe_path(name)
    suffix = PurePosixPath(path).suffix.lower()
    if suffix not in MIMES:
        raise ValueError("Allowed types: PDF, DOCX, TXT, MD, HTML")
    if not content or len(content) > MAX_FILE_BYTES:
        raise ValueError("File must contain data and be no larger than 50 MB")
    if suffix == ".pdf":
        if not content.startswith(b"%PDF-"):
            raise ValueError("PDF extension does not match file content")
    elif suffix == ".docx":
        try:
            with zipfile.ZipFile(io.BytesIO(content)) as archive:
                entries = archive.infolist()
                if (len(entries) > 10000 or sum(i.file_size for i in entries) > 100 * 1024 * 1024
                        or "word/document.xml" not in archive.namelist()
                        or "[Content_Types].xml" not in archive.namelist()):
                    raise ValueError("Invalid or oversized DOCX archive")
        except zipfile.BadZipFile as exc:
            raise ValueError("DOCX extension does not match file content") from exc
    else:
        if content.startswith((b"%PDF", b"PK\x03\x04", b"MZ", b"\x7fELF")) or b"\x00" in content:
            raise ValueError("Text extension does not match file content")
        try:
            text = content.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise ValueError("Text documents must use UTF-8 encoding") from exc
        if suffix in (".html", ".htm") and not re.search(r"<(?:!doctype\s+html|html|body|article|main|p|h1)\b", text, re.IGNORECASE):
            raise ValueError("HTML extension does not match file content")
    return path, MIMES[suffix]


def extract(content: bytes, mime: str) -> tuple[list[dict], str]:
    title = ""
    try:
        if mime == "application/pdf":
            with fitz.open(stream=content, filetype="pdf") as pdf:
                if pdf.needs_pass or len(pdf) > 2000:
                    raise ValueError("Encrypted PDF or PDF over 2000 pages is unsupported")
                title = (pdf.metadata or {}).get("title") or ""
                pages = [{"page": i + 1, "text": page.get_text("text")} for i, page in enumerate(pdf)]
        elif mime == MIMES[".docx"]:
            doc = Document(io.BytesIO(content))
            # DOCX has no stable rendered page numbers; retain one logical page in document order.
            text = "\n".join(block.text if hasattr(block, "text") else
                             "\n".join(" | ".join(c.text for c in r.cells) for r in block.rows)
                             for block in doc.iter_inner_content())
            pages = [{"page": 1, "text": text}]
            title = doc.core_properties.title or ""
        elif mime in ("text/html", "application/xhtml+xml"):
            text, titles = html_to_text(content)
            pages = [{"page": 1, "text": text}]
            title = next(iter(titles), "")
        else:
            pages = [{"page": 1, "text": content.decode("utf-8-sig")}]
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError("Document could not be extracted; it may be corrupt or encrypted") from exc
    if not any(p["text"].strip() for p in pages):
        raise ValueError("No extractable text; scanned/empty documents need OCR before import")
    if sum(len(p["text"]) for p in pages) > MAX_TEXT_CHARS:
        raise ValueError("Extracted text exceeds 10 million characters")
    return pages, title.strip()[:500]
