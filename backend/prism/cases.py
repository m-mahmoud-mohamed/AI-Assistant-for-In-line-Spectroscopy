"""Load development (D01–D08) and evaluation (H01–H06) enquiries verbatim from the supplied files."""
from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Literal

import docx

from prism.schemas import Enquiry

EXAMPLES_DOCX = "AFS_Examples_and_Reference.docx"
EVAL_TXT = "customer_scenarios_for_final_evaluation.txt"
_D_HEAD = re.compile(r"^(D0[1-8])\s+·\s+(.+)$")


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def file_sha256(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _paragraphs(path: Path) -> list[str]:
    return [p.text.strip() for p in docx.Document(str(path)).paragraphs if p.text.strip()]


def _index(paras: list[str], prefix: str) -> int:
    return next(i for i, p in enumerate(paras) if p.startswith(prefix))


def load_dev_cases(materials: Path) -> list[Enquiry]:
    paras = _paragraphs(materials / EXAMPLES_DOCX)
    end = _index(paras, "2. Worked examples")
    found: dict[str, tuple[str, str]] = {}
    for i, p in enumerate(paras[:end]):
        m = _D_HEAD.match(p)
        if m and m.group(1) not in found:
            found[m.group(1)] = (m.group(2).strip(), paras[i + 1])
    return [Enquiry(case_id=cid, title=title, text=body, sha256=sha256_text(body), origin="case_file")
            for cid, (title, body) in sorted(found.items())]


def load_worked_examples(materials: Path) -> dict[str, str]:
    paras = _paragraphs(materials / EXAMPLES_DOCX)
    start, stop = _index(paras, "2. Worked examples"), _index(paras, "3. Answer structure")
    out: dict[str, list[str]] = {}
    current = None
    for p in paras[start + 1:stop]:
        m = _D_HEAD.match(p)
        if m:
            current = m.group(1)
            out[current] = [p]
        elif current:
            out[current].append(p)
    return {k: "\n".join(v) for k, v in out.items()}


def load_eval_cases(materials: Path) -> list[Enquiry]:
    raw = (materials / EVAL_TXT).read_text(encoding="utf-8")
    blocks = re.split(r"^=+\s*$", raw, flags=re.MULTILINE)
    out = []
    for j, block in enumerate(blocks):
        m = re.match(r"\s*(H0[1-6])\s*\|\s*(.+?)\s*$", block, flags=re.DOTALL)
        if m:
            text = blocks[j + 1].strip()
            out.append(Enquiry(case_id=m.group(1), title=m.group(2).strip(), text=text,
                               sha256=sha256_text(text), origin="case_file"))
    return out


def load_cases(materials: Path, which: Literal["dev", "eval", "all"]) -> list[Enquiry]:
    if which == "dev":
        return load_dev_cases(materials)
    if which == "eval":
        return load_eval_cases(materials)
    return load_dev_cases(materials) + load_eval_cases(materials)
