"""Stage 4: three section writers run in parallel; each fills the prose of a code-built skeleton."""
from __future__ import annotations

from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor, as_completed

from pydantic import BaseModel

from prism.assist.sections import SECTION_SCHEMAS, SECTIONS, Skeleton, finding_lines
from prism.llm.gateway import LLMUnavailable
from prism.llm.prompts import render
from prism.schemas import Card, Enquiry, EvidencePack, RequirementsSheet, RuleFindings

MAX_WRITERS = 3
SHOWN_CANDIDATES = 12


def _line(c: Card) -> str:
    if c.source == "EXT":          # verified web source: say so, and where it came from
        v = c.verification
        where = f"{v.domain}, retrieved {(c.retrieved_at or '')[:10]}" if v else "unverified"
        return f'[{c.id}] ({c.citation()}, external; verified web source {where}) {c.claim} — "{c.quote}"'
    return f'[{c.id}] ({c.citation()}, {c.scope.value}) {c.claim} — "{c.quote}"'


def evidence_lines(cards: EvidencePack | Iterable[Card]) -> list[str]:
    return [_line(c) for c in (cards.cards if isinstance(cards, EvidencePack) else cards)]


def build_section_messages(section: str, enquiry: Enquiry, sheet: RequirementsSheet, findings: RuleFindings,
                           skeleton: Skeleton, cards: list[Card], exemplars: dict[str, str], chat_facts=(),
                           confirmed: dict[str, str] | None = None, preferences=()) -> tuple[list[dict], str]:
    system, h1 = render("section_system.j2", section=section)
    user, h2 = render(
        "section_user.j2", section=section, title=enquiry.title, text=enquiry.text, chat_facts=list(chat_facts),
        confirmed=dict(confirmed or {}), preferences=list(preferences),
        sheet_json=sheet.model_dump_json(indent=1, exclude_defaults=True), skeleton=skeleton,
        findings=finding_lines(findings), candidates=findings.candidates[:SHOWN_CANDIDATES],
        evidence=evidence_lines(cards), exemplars=exemplars, client_question=sheet.client_question)
    if any(c.source == "EXT" for c in cards):          # runs without web sources keep byte-identical prompts
        user += render("web_draft.j2")[0]
    return [{"role": "system", "content": system}, {"role": "user", "content": user}], f"{h1}{h2}"[:12]


def section_role(gateway, role: str, section: str) -> str:
    """`writer_plan`, `writer_concept`, ... when the profile routes that section to its own models (on a provider
    that queues parallel calls to one model, three writers on one model run one after the other), else `role`."""
    roles = getattr(getattr(gateway, "profile", None), "roles", None) or {}
    return f"{role}_{section}" if f"{role}_{section}" in roles else role


def write_sections(enquiry: Enquiry, sheet: RequirementsSheet, findings: RuleFindings, skeleton: Skeleton,
                   slices: dict[str, list[Card]], gateway, exemplars: dict[str, str], chat_facts=(),
                   confirmed: dict[str, str] | None = None, preferences=(), role: str = "writer",
                   on_section: Callable[[str, BaseModel], None] | None = None,
                   sections=SECTIONS) -> tuple[dict[str, BaseModel], dict]:
    """Run the three writers concurrently. `on_section(name, draft)` is called in the caller's thread as each one
    finishes (so the caller can emit events without locks). A writer whose models all failed (for example the output
    was cut at max_tokens) leaves its section to be filled by code and is reported in `meta["failed"]`; when every
    writer fails the run fails. Any other error (a replay miss, a programming error) propagates."""
    messages, hashes = {}, []
    for section in sections:
        messages[section], h = build_section_messages(section, enquiry, sheet, findings, skeleton, slices[section],
                                                      exemplars, chat_facts, confirmed, preferences)
        hashes.append(h)
    drafts: dict[str, BaseModel] = {}
    models: dict[str, str] = {}
    failed: dict[str, str] = {}
    with ThreadPoolExecutor(max_workers=MAX_WRITERS, thread_name_prefix="writer") as pool:
        futures = {pool.submit(gateway.complete, section_role(gateway, role, s), messages[s],
                               schema=SECTION_SCHEMAS[s]): s for s in sections}
        for future in as_completed(futures):
            section = futures[future]
            try:
                res = future.result()
            except LLMUnavailable as exc:
                failed[section] = str(exc)[:200]
                continue
            drafts[section], models[section] = res.parsed, res.model
            if on_section is not None:
                on_section(section, res.parsed)
    if failed and len(failed) == len(sections):
        raise LLMUnavailable("all section writers failed: " + "; ".join(failed.values()))
    return drafts, {"model": models.get("answer") or next(iter(models.values()), ""), "models": models,
                    "failed": failed, "prompt_hash": "".join(hashes)[:12]}
