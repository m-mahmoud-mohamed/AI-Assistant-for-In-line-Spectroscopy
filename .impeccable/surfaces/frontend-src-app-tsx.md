---
version: 1
slug: "frontend-src-app-tsx"
primary_target: "frontend/src/App.tsx"
related_targets: []
---

---
version: 1
slug: "frontend-src-app-tsx"
primary_target: "frontend/src/App.tsx"
related_targets: []
---

# Surface: PRISM assistant app (frontend/src/App.tsx)

Scope: the whole single-page app (home, thread with report, right panel, history, drawers). Visitor mode: Operate.
Audience/job: AFS application scientist pastes a client enquiry, watches the pipeline run, reads and checks the cited assessment, asks follow-ups, exports.
Constraints: no predefined example cases or mock demo data; no user names; keep every existing capability (streaming pipeline, report sections, charts, evidence viewer, chat agent, report versions/diff, exports, e-mail draft, deep mode, refusal suggestions).

## Direction contract

THESIS: The Lumeo AI-assistant result screen, reproduced faithfully (user-pinned), carrying PRISM's cited assessment instead of travel tips. Refuses the old dark navy dashboard with tabs and a chat side-drawer: one calm thread, answer first, evidence one click away.

OWN-WORLD: White app card (radius 24) floating on #e6e6e6 ground; 1px #e9ecf2 hairlines; Inter-style grotesk; ink #0e121b, body #4b4f5c, muted #7f7e84; violet accent #6a42e0 (active rail bar, links), lavender #dcd5ff user bubble, soft panels #f6f7fb, black pill primary button #0e121b, glossy purple orb (#c13dfc → #7b2ff7 with white specular highlight and lilac glow), magenta-violet emphasis words (#c13dfc→#7b3ff2).

STORY: The visitor sees an orb and "Good afternoon. Which process should we look inside?", pastes an enquiry, watches the composer glide down and the enquiry bubble settle top-right, sees pipeline steps tick and sources and results stream in, then reads status, recommendation, methods, plan, questions; asks follow-ups or exports.

FIRST VIEWPORT: Left icon rail 100px (AFS emblem top, nav icons, settings bottom). Top bar 110px: reasoning-mode select and report-version select left, "Assessments / <title>" breadcrumb centre, Search, Export, black "New enquiry" right. Centre: 100px orb, two-line 48px greeting, composer 880px wide with attach, Deep toggle, send.

FORM: User-pinned reference (Dribbble 25712260 "Lumeo – AI Assistant Result"). Seed key: none — roll waived by the user's pinned brief, verbatim: "use this ui with same animations https://dribbble.com/shots/25712260-Lumeo-AI-Assistant-Result" and, when offered AFS-branded variants, "no i want same ui that i provided with animation" (2026-10-17). Signature move: the submit choreography (greeting blur-out, composer FLIP to bottom, bubble rise, right-panel skeletons, word-by-word blur-in of sources and results, typing breadcrumb).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
