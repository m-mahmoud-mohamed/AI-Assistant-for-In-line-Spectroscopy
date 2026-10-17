# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Application scientists and sales engineers at Art Fiber Systems (AFS) who receive client enquiries about in-line process spectroscopy and must answer them with a defensible first assessment. Secondary audience: the SchubKI hackathon jury, who see the product in a live demo. (Inferred from docs/SOLUTION_PLAN.md and the challenge brief.)

## Product Purpose

PRISM turns a free-text client enquiry into a cited feasibility assessment: which spectroscopic method (NIR, MIR, Raman, UV-Vis, fluorescence) and which AFS fiber probe fit the process, what is still unknown, which questions to ask the client next, and a feasibility plan. Success means an AFS expert can trust, check and forward the answer without rewriting it.

## Positioning

A neuro-symbolic pipeline rather than a chatbot: every claim is grounded in a verbatim quote from AFS material, a deterministic rule and physics engine decides method fit and decision status, and the LLM may only make a decision stricter. The UI must make that grounding visible (sources, claim types, decision status, pipeline trace).

## Operating Context

Used at a desk during enquiry triage; runs take about 1 minute (standard) or longer (deep mode) and stream progress stage by stage. Follow-up questions happen in a chat on the same session; a chat message may start a new report version. Reports export as Markdown, JSON, print/PDF and a customer e-mail draft.

## Capabilities and Constraints

- Backend: FastAPI with SSE run events, sessions, report versions, chat agent, evidence cards with page images (docs/ARCHITECTURE.md §8).
- Decision statuses: PROVISIONAL, INSUFFICIENT_INFORMATION, OUTSIDE_SUPPORTED_SCOPE; out-of-scope enquiries are refused with suggestions.
- Claim types: CLIENT, AFS, EXTERNAL, ASSUMPTION, PROPOSAL, UNKNOWN.
- No built-in example enquiries in the UI: users start from their own text (user decision, 2026-10-17).
- No user accounts or names exist; nothing in the UI may imply them.

## Brand Commitments

- Visual reference pinned by the user: the Dribbble shot "Lumeo – AI Assistant Result" (Barly Design for Uxerflow), including its light look, lavender/violet accent, purple orb and its animations. Follow it as closely as the product's content allows.
- The AFS logo/emblem (frontend/public/brand/) is the product mark.

## Evidence on Hand

- Challenge materials and AFS slides in materials/; knowledge base cards in kb/.
- Evaluation results in docs/EVAL_RESULTS.md.
- No customer testimonials, logos or benchmarks beyond these; none may be invented.

## Product Principles

1. Show the evidence: every answer points to its source page.
2. Status before prose: the decision status and its reason are never hidden.
3. Honest about unknowns: missing information is surfaced as questions, not papered over.
4. Fast to read, deep on demand: the summary leads, the detail is one step away.
