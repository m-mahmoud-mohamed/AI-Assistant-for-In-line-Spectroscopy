"""The living report: what a follow-up message is, and what it changes in the assessment.

`triage` sorts a message into client facts, expert instructions and questions with code only; a message it cannot sort
is left `unclear` (the harness then makes one small classifier call). `impact` compares the engine's state before and
after the new information: a change of status, of the primary method or of the set of recommendations is MAJOR (the
scientist approves it first); everything else is minor and revises the affected report sections on its own.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from prism.assist.sections import SECTIONS, Skeleton
from prism.schemas import DecisionStatus, RecRole

SECTION_LABELS = {"answer": "direct answer and recommendations",
                  "concept": "measurement concept, spectral ranges and risks",
                  "plan": "questions, feasibility plan and decision basis"}
STATUS_WORDS = {DecisionStatus.PROVISIONAL: "Provisional",
                DecisionStatus.INSUFFICIENT_INFORMATION: "Insufficient information",
                DecisionStatus.OUTSIDE_SUPPORTED_SCOPE: "Outside the supported scope"}

_SENTENCE = re.compile(r"(?<=[.!?])\s+(?=\S)|\n+")
_QUESTION = re.compile(r"(?i)^(?:and |also |but |so )?(?:what|why|how|which|who|where|when|is|are|can|could|should|"
                       r"would|does|do|did|will|may|might|explain|compare|tell me|show me|give me|describe|"
                       r"summari[sz]e|clarify)\b")
_HYPOTHETICAL = re.compile(r"(?i)\b(?:what if|suppose|supposing|assuming|assume that|imagine|hypothetically|"
                           r"in case the|were the|would it)\b")
_INSTRUCTION = re.compile(r"(?i)^(?:please |also |and |now )?(?:prefer|focus|include|exclude|avoid|prioriti[sz]e|"
                          r"emphasi[sz]e|stress|shorten|keep|make|use|write|put|add|drop|skip|leave out|don't|do not|"
                          r"never|always)\b")
_POLITE_INSTRUCTION = re.compile(r"(?i)^(?:(?:can|could|would|will) you |please )(?:please )?(?:prefer|focus|include|"
                                 r"exclude|avoid|prioriti[sz]e|emphasi[sz]e|stress|shorten|keep|make|use|write|add|"
                                 r"drop|skip|leave out)\b")
_FACT = re.compile(
    r"(?i)\b(?:we|i|they|the client|the customer|client|customer|our)\b.*\b(?:have|has|had|are|is|were|was|use|uses|"
    r"using|run|runs|measure[ds]?|need[s]?|want[s]?|can|cannot|can't|will|won't|operate[s]?|produce[s]?|plan[s]?|"
    r"confirm(?:ed|s)?|said|says|told|stated)\b"
    r"|\b(?:correction|actually|in fact|update|note that|fyi|new fact)\b"
    r"|\bthe (?:product|sample|samples|stream|process|pipe|pipeline|line|probe|fluid|liquid|material|powder|reactor|"
    r"tank|temperature|pressure|flow|distance|concentration|matrix|batch|acceptance|accuracy|target|reference|"
    r"window|fiber|fibre)\b.*\b(?:is|are|has|have|was|were|will|reaches|runs|stays|can|cannot)\b"
    r"|\d")
# A request for content (a conversion, a draft, a list, a comparison) is something to answer, never new client
# information, even when it contains numbers; it instructs the report only when it is about the report itself.
_REQUEST = re.compile(r"(?i)^(?:please |kindly |now |also |and )?(?:(?:can|could|would|will) you (?:please )?)?"
                      r"(?:convert|calculate|compute|estimate|derive|draft|write|prepare|create|generate|outline|"
                      r"sketch|list|rank|translate|check|verify|suggest|propose|recommend|evaluate|assess|plot|"
                      r"tabulate|explain|compare|summari[sz]e)\b")
_REPORT_ITSELF = re.compile(r"(?i)\b(?:the|this) (?:report|assessment)\b")
_ABOUT_THE_REPORT = re.compile(r"(?i)\b(?:you|your|the report|the assessment|the answer|the summary|thanks|thank you)\b")

# Sections a fact touches when the engine's own state did not change (keywords, then the plan as the default).
_TOUCHES = (
    ("plan", re.compile(r"(?i)sampl|reference|split|validat|calibrat|batch|experiment|trial|criteri|acceptance|"
                        r"duration|budget|timeline|leak|train|test set|replicate|repeat")),
    ("concept", re.compile(r"(?i)temperature|pressure|probe|fib[er]+|optic|window|geometry|foul|install|flow|bypass|"
                           r"sapphire|pipe|vibration|distance|length|link|risk|hazard|atex|cleaning")),
    ("answer", re.compile(r"(?i)target|premise|recommend|method|NIR|MIR|Raman|concentration|accuracy|precision|"
                          r"prefer|focus|emphasi|primary|first")),
)


@dataclass(frozen=True)
class Triage:
    kind: str                       # question | fact | instruction | mixed | unclear
    facts: tuple[str, ...] = ()
    instructions: tuple[str, ...] = ()
    questions: tuple[str, ...] = ()

    @property
    def revises(self) -> bool:
        return bool(self.facts or self.instructions)


def triage(text: str) -> Triage:
    """Sort a follow-up into facts (declarative statements about the client, process or samples), instructions
    (the expert's preferences for the report) and questions. Hypotheticals are questions, never facts."""
    facts, instructions, questions = [], [], []
    for raw in _SENTENCE.split(text.strip()):
        s = " ".join(raw.split())
        if not s:
            continue
        if _POLITE_INSTRUCTION.match(s):
            instructions.append(s)
        elif s.endswith("?") or _HYPOTHETICAL.search(s):
            questions.append(s)
        elif _REQUEST.match(s):
            (instructions if _REPORT_ITSELF.search(s) else questions).append(s)
        elif _INSTRUCTION.match(s):
            instructions.append(s)
        elif _QUESTION.match(s):
            questions.append(s)
        elif _FACT.search(s) and not _ABOUT_THE_REPORT.search(s):
            facts.append(s)
    if not (facts or instructions):
        return Triage("question" if questions else "unclear", questions=tuple(questions))
    kind = "mixed" if questions else "instruction" if instructions and not facts else "fact"
    return Triage(kind, tuple(facts), tuple(instructions), tuple(questions))


# ---------------------------------------------------------------- what a change does to the report

@dataclass(frozen=True)
class Impact:
    major: bool
    sections: tuple[str, ...]
    summary: str
    details: dict = field(default_factory=dict)


def _recs(sk: Skeleton) -> set[tuple]:
    return {(tuple(r.methods), r.technique, r.role.value, tuple(r.applies_to)) for r in sk.recs}


def _lead(sk: Skeleton) -> str:
    return next((" + ".join(r.methods) + " " + r.technique for r in sk.recs
                 if r.role in (RecRole.PRIMARY, RecRole.SCREENING)), "none")


def impact(before: Skeleton, after: Skeleton, trigger: str) -> Impact:
    """Compare the engine's skeletons: major when the status or the primary method changes, or a recommendation is
    added or removed. The affected sections follow from what changed (the plan when nothing in the engine did)."""
    status_changed = before.status != after.status
    lead_changed = _lead(before) != _lead(after)
    old, new = _recs(before), _recs(after)
    added, removed = new - old, old - new
    major = status_changed or lead_changed or bool(added or removed)
    changed: set[str] = set(SECTIONS) if status_changed else set()
    if not status_changed:
        for section, names in (("answer", ("recs", "premises")), ("concept", ("concepts", "ranges")),
                               ("plan", ("questions", "plan"))):
            if any(getattr(before, n) != getattr(after, n) for n in names):
                changed.add(section)
        if added or removed or lead_changed:
            changed.update(("answer", "concept", "plan"))
        engine_changed = bool(changed)
        for section, pattern in _TOUCHES:
            if pattern.search(trigger) and (not engine_changed or section == "plan"):
                changed.add(section)
        if not changed:
            changed.add("plan")
    sections = tuple(s for s in SECTIONS if s in changed)
    closed = sorted({q.slot for q in before.questions} - {q.slot for q in after.questions})
    opened = sorted({q.slot for q in after.questions} - {q.slot for q in before.questions})
    parts = []
    if lead_changed:
        parts.append(f"Primary method {_lead(before)} → {_lead(after)}")
    if status_changed:
        parts.append(f"Status {STATUS_WORDS[before.status]} → {STATUS_WORDS[after.status]}")
    if (added or removed) and not lead_changed:
        parts.append("Recommendations " + ("added" if added and not removed else "removed" if removed and not added
                                            else "added and removed"))
    if closed:
        parts.append(f"{len(closed)} open question{'s' if len(closed) != 1 else ''} settled")
    parts.append("Updated " + ", ".join(SECTION_LABELS[s] for s in sections))
    return Impact(major, sections, ". ".join(parts) + ".",
                  {"status": [before.status.value, after.status.value] if status_changed else None,
                   "primary": [_lead(before), _lead(after)] if lead_changed else None,
                   "recommendations_added": len(added), "recommendations_removed": len(removed),
                   "questions_settled": closed, "questions_new": opened})
