---
name: PRISM
description: AFS in-line spectroscopy assistant; a conversation beside a tabbed report workspace, answer first, evidence one click away.
colors:
  ground: "#e6e6e6"
  card: "#ffffff"
  soft: "#f6f7fb"
  chip: "#f5f6fa"
  hairline: "#e9ecf2"
  hairline-strong: "#e4e7ee"
  rail-sep: "#eef0f4"
  track: "#e2e3e8"
  ink: "#0e121b"
  body: "#4b4f5c"
  muted: "#6c6b73"
  placeholder: "#767680"
  violet: "#6a42e0"
  violet-hover: "#5a33cf"
  violet-soft: "#efeafe"
  bubble: "#dcd5ff"
  bubble-ink: "#1b1530"
  star: "#335bfb"
  magenta: "#c13dfc"
  purple: "#7b3ff2"
  orb-light: "#f0b6ff"
  orb-mid: "#c13dfc"
  orb-deep: "#7b2ff7"
  status-ok: "#0f9d6b"
  status-ok-bg: "#e8f7f0"
  status-warn: "#b26b00"
  status-warn-bg: "#fff4e0"
  status-bad: "#c0362c"
  status-bad-bg: "#fdecea"
typography:
  display:
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "36px"
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: "-0.02em"
    fontFeature: "'cv11', 'ss01'"
  headline:
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "19px"
    fontWeight: 600
    lineHeight: 1.3
  title-sm:
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "17px"
    fontWeight: 500
    lineHeight: 1.3
  body:
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.6
    fontFeature: "'cv11', 'ss01'"
  body-sm:
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.45
  caption:
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.5
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, monospace"
    fontSize: "12px"
    fontWeight: 400
rounded:
  xs: "6px"
  sm: "8px"
  md: "10px"
  lg: "12px"
  xl: "16px"
  card: "24px"
  pill: "999px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "20px"
  xl: "24px"
  section: "28px"
components:
  button:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0 14px"
    height: "36px"
  button-hover:
    backgroundColor: "{colors.soft}"
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.card}"
    rounded: "{rounded.sm}"
    padding: "0 14px"
    height: "36px"
  button-sm:
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "32px"
  send-button:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.card}"
    rounded: "{rounded.sm}"
    size: "32px"
  composer:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "8px 8px 8px 10px"
  user-bubble:
    backgroundColor: "{colors.bubble}"
    textColor: "{colors.bubble-ink}"
    padding: "12px 16px"
  tab:
    textColor: "{colors.body}"
    typography: "{typography.body-sm}"
    height: "44px"
  tab-active:
    textColor: "{colors.ink}"
  key-facts:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "10px 14px"
  recommendation-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.body}"
    rounded: "{rounded.lg}"
    padding: "14px 16px"
  chip:
    backgroundColor: "{colors.chip}"
    textColor: "{colors.body}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
  pill-info:
    backgroundColor: "{colors.violet-soft}"
    textColor: "{colors.violet}"
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
  pill-ok:
    backgroundColor: "{colors.status-ok-bg}"
    textColor: "{colors.status-ok}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
  pill-warn:
    backgroundColor: "{colors.status-warn-bg}"
    textColor: "{colors.status-warn}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
  pill-bad:
    backgroundColor: "{colors.status-bad-bg}"
    textColor: "{colors.status-bad}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
  citation-chip:
    backgroundColor: "{colors.violet-soft}"
    textColor: "{colors.violet}"
    rounded: "5px"
    padding: "0 5px"
  rail-item:
    textColor: "{colors.body}"
    rounded: "{rounded.md}"
    size: "36px"
  rail-item-active:
    backgroundColor: "{colors.soft}"
    textColor: "{colors.violet}"
---

# Design System: PRISM

## Overview

**Creative North Star: "The Calm Thread"**

PRISM is a light, quiet working surface: one white app card (24px corners) floating on a flat grey ground, a narrow icon rail on the left and a hairline top bar. Home is the orb, the greeting and one centred composer. Once a session has an assessment the card becomes a two-pane workspace: a conversation column of about 400px (the enquiry, the run, follow-ups, suggested tasks and the docked composer) beside a white report pane that carries a sticky title bar, a key-facts strip and an underline tab bar (Overview, Methods, Spectral, Concept, Plan, Questions, Evidence, Checks). The conversation stays the calm thread; the report is a workspace a scientist can scan, compare and check against its sources. The world is pinned by the user to the Dribbble reference "Lumeo – AI Assistant Result", and the build follows it closely: Inter grotesk, ink-and-grey text, a single violet accent, a lavender user bubble, a black primary button, and a glossy purple orb as the only illustrative object.

Density is moderate in the conversation and higher in the report pane, where the data lives: tables with hairline rows, tabular numerals and a sticky header row, a four-stat key-facts strip, recommendation cards, tinted premise panels. Hierarchy still comes from weight and ink colour: sections are separated by 28px of air, prose stays at 15px, and the long tail (rule findings, run details) sits behind one-line disclosure rows. Colour is spent on meaning: violet for the active place, the active tab and for links and citations, the quiet status trio (green, amber, red on tinted fills) for decision state, and the orb gradient for the assistant's presence. The old dark navy dashboard and chat side-drawer are the confirmed rejection; the tabs that came back are white underline tabs inside the Lumeo card, not that dashboard.

Motion is the signature, and it is rationed by how often something happens. Submitting an enquiry blurs the greeting out, glides the composer into the conversation column (FLIP), raises the lavender bubble, fills the report pane with skeleton header and tab bar around the live pipeline, and then blurs the report header and the Overview in once, all on one ease-out curve. Tabs are switched all day, so they move almost nothing: the underline slides on transform and the panel fades in over 120ms. Every motion has a reduced-motion fallback that collapses to a short fade or nothing.

**Key Characteristics:**
- White card (24px radius) on a #e6e6e6 ground; 12px inset; full-bleed below 1024px.
- One violet accent; one black primary button with 8px corners; tinted status pills.
- Inter at 15px/1.6 body; weight and ink, not size jumps, carry hierarchy.
- Flat surfaces separated by 1px cool hairlines; shadows only on floating layers.
- Blur-in, word-reveal and FLIP motion on a single ease-out curve, with reduced-motion fallbacks.
- A two-pane workspace at 1180px and up: conversation column (about 400px) and a report pane (content to 920px) with Lumeo underline tabs; one pane at a time below, chosen by a segmented control.

## Colors

A near-monochrome cool-grey world with one violet voice and an orb-gradient garnish.

### Primary
- **Signal Violet** (`violet`): the active rail bar and active icon, links and link buttons, citation chip text, the on state of switches, focus outline, caret and `accent-color`. Hover deepens to `violet-hover`.
- **Violet Wash** (`violet-soft`): fill behind citation chips and info pills; never a surface.
- **Lavender Bubble** (`bubble`, text `bubble-ink`): the user's enquiry bubble and the text selection colour; nothing else.

### Secondary
- **Source Star Blue** (`star`): the scope icon of internal (AFS) sources in the Evidence tab and the evidence viewer (web sources use body grey).

### Tertiary
- **Orb Gradient** (`orb-light` → `orb-mid` → `orb-deep`): the glossy orb, its specular highlight and lilac halo.
- **Greeting Emphasis** (`magenta` → `purple`): the gradient carried by the emphasis words of the home greeting. This is a sanctioned exception pinned by the reference, used in exactly that one place.

### Neutral
- **Ground Grey** (`ground`): the page behind the app card.
- **Card White** (`card`): the app card, the report pane, buttons, composer, recommendation cards, menus, modals.
- **Soft Panel** (`soft`): source rows in the Evidence list, hover fills, the rail's active pill, notices, tab count pills, keyboard hints.
- **Chip Grey** (`chip`): suggestion chips and suggested-question rows.
- **Hairlines** (`hairline`, `hairline-strong`, `rail-sep`): 1px dividers and button/card strokes; the strong variant on buttons, the top bar, the pane divider, the tab rule and table headers, the light variant on table rows.
- **Track** (`track`): off state of switches.
- **Ink** (`ink`): headings, the greeting, button labels, the primary button fill.
- **Body** (`body`): running text, icons at rest.
- **Muted** (`muted`): metadata, step times, secondary notes. Darkened from the reference's #7f7e84 to hold 4.5:1 on white.
- **Placeholder** (`placeholder`): input placeholders.

### Status
- **OK / Warn / Bad** (`status-ok`, `status-warn`, `status-bad` on their `-bg` tints): decision status pills, verification marks, inline errors. Always text-on-tint, never solid fills.

### Named Rules
**The One Voice Rule.** Violet is the only interactive accent. If something is clickable and coloured, it is violet; if it is coloured and not violet, it is status or the orb.

**The Bubble Belongs to the User Rule.** Lavender marks the user's own words (the enquiry bubble, selected text). The assistant's content never sits on lavender.

## Typography

**Display Font:** Inter (with system-ui, -apple-system, Segoe UI)
**Body Font:** Inter (same stack), with `cv11` and `ss01` features on
**Label/Mono Font:** JetBrains Mono for codes, ids and raw values

**Character:** One neutral grotesk carries everything; the reference pins Inter and the build keeps it as a sanctioned exception. Personality comes from the ink/grey split and from the greeting's emphasis words, not from a second family.

### Hierarchy
- **Display** (500, 36px, 1.15, -0.02em; 28px below 640px): the two-line home greeting only.
- **Headline** (600, 26px, 1.2, -0.01em): page heading on full-page views such as History.
- **Title** (600, 19px, 1.3): the live pipeline heading and each tab's title when the report is printed.
- **Title Small** (500, 17px, 1.3): modal and drawer titles; the report title in the sticky bar is 600.
- **Body** (400, 15px, 1.6): report prose, the bubble, the composer, step lines. The conversation column is about 376px of text; report content is at most 920px wide.
- **Body Small** (400, 14px, 1.5): buttons, tabs, table cells, pipeline summary line, breadcrumb-adjacent text.
- **Label** (500, 13px): chips, source meta, notes.
- **Caption** (500, 12px): status pills, table header cells (600), key-fact labels, tab counts; 11px only for the citation chip and claim markers.

### Named Rules
**The Weight Not Size Rule.** In-report section labels (Recommendations, Direct answer, Candidate methods) stay at body size (15px) and step up to 600 ink. Size jumps are reserved for the greeting, page headings and the report title.

**The Tabular Rule.** Tables, times and counts use tabular numerals.

## Layout

The app is a flex shell inside a white card inset 12px from the viewport (`--card-inset`). The rail is 72px wide with a 1px separator; the top bar is 80px tall with 28px side padding: mode and report-version selects on the left, a centred "Assessments / title" breadcrumb, and Search, Export and the black "New enquiry" button on the right.

**Workspace (1180px and up).** The stage splits into a conversation column (`clamp(360px, 28vw, 420px)`, its own scroll, 20px side padding) and a report pane that fills the rest (its own scroll, white, a 1px hairline on its left edge). The docked composer sits at the bottom of the conversation column, its suggested-task chips stacked above it; a 170px white-to-#f6f6f6 fade sits under it. Because the composer is narrow there, its controls wrap onto a second row (a container query on the composer, not a media query).

**Report pane.** A 60px sticky title bar (report title, version and date, actions) is followed by what scrolls away (status and verdict pills, the one-sentence direct answer, the four-stat key-facts strip) and then the 45px sticky tab bar. Tab content sits in a column at most 976px wide (920px of content plus 28px gutters, 16px on a narrow pane) with 28px between sections and 96px of bottom space. Tables fit the column and their header row sticks under the tab bar; on a pane narrower than 860px they scroll inside their own container instead. The Evidence tab splits into the source list and the selected source's viewer from 760px of pane width; narrower, the viewer takes the list's place.

**Home** is unchanged: the orb (72px), greeting and composer form one group resting at roughly 45% of the card height (4:6 flex split above and below), not dead centre; the composer is 634px wide there.

Spacing rhythm: 8 / 12 / 16 / 20 / 24 / 28px. Section gap 28px, intra-section 8 to 14px.

Responsive behaviour:
- **Below 1180px**: one pane at a time. A segmented control (Conversation | Report) at the top of the stage switches; the report is selected once it exists, and the composer shows only with the conversation. The conversation column is centred at 634px.
- **Below 1024px**: the card goes full-bleed with no radius.
- **Below 900px**: secondary top-bar buttons drop their labels.
- **Below 760px**: the rail becomes a bottom tab bar, the top bar shrinks to 64px with icon-only buttons and no breadcrumb, and the report's actions collapse into one "More actions" menu next to the title.
- **Report pane width**: below 1040px the Copy, E-mail draft and Re-run buttons are icon-only; below 860px tables scroll inside their container; below 760px the Overview pairs and the Evidence split stack; below 700px the key facts form a 2x2 grid and Export loses its label.

## Elevation & Depth

Flat by default. Resting surfaces (card, recommendation cards, tables, tabs, chips) carry no shadow; depth comes from the grey ground under the white card and from soft-panel fills against white. Shadows appear only on things that float: menus, modals, drawers, tooltips, and the composer, which hovers over the conversation. Shadows are cool (rgba(16,24,40,…)) and diffuse, except the composer's faint violet-tinted lift. Buttons carry a 1px hairline lift.

### Shadow Vocabulary
- **Hairline lift** (`box-shadow: 0 1px 2px rgba(16, 24, 40, 0.05)`): outline buttons.
- **Composer float** (`box-shadow: 0 8px 24px rgba(106, 66, 224, 0.06), 0 1px 2px rgba(16, 24, 40, 0.04)`): the composer at rest.
- **Focus halo** (`box-shadow: 0 0 0 3px rgba(106, 66, 224, 0.16)`): composer and text areas on focus, with the border shifting to #8f75ec.
- **Menu** (`box-shadow: 0 12px 32px rgba(16, 24, 40, 0.12), 0 2px 6px rgba(16, 24, 40, 0.06)`): dropdowns and export menu.
- **Modal** (`box-shadow: 0 24px 64px rgba(16, 24, 40, 0.18), 0 4px 12px rgba(16, 24, 40, 0.08)`): modals and the command palette.
- **Drawer** (`box-shadow: -16px 0 48px rgba(16, 24, 40, 0.14)`): right-side drawers (pipeline graph, stage detail).
- **Orb glow** (`box-shadow: inset -7px -10px 16px rgba(78, 14, 150, 0.45), inset 5px 6px 12px rgba(255, 220, 255, 0.35), 0 18px 50px rgba(193, 61, 252, 0.35)`): the orb only.

### Named Rules
**The Float-Only Shadow Rule.** A surface gets a shadow only if it floats above the page. Cards, tables and tabs inside the conversation and the report pane are flat.

## Shapes

Soft, consistent rounded rectangles; nothing sharp, nothing fully pill-shaped except status pills and switches. The app card is 24px; modals 16px; the composer, recommendation cards, the key-facts strip, the evidence viewer, menus and question rows 12px; chips, rail items and skeletons 10px; buttons and the send button 8px; small inline marks (kbd hints, priority tags) 6px; the citation chip 5px. The user bubble is 16px with its bottom-right corner tucked to 4px, pointing at its sender. Strokes are 1px cool hairlines; dashed hairlines mark unknowns.

## Components

### Buttons
Quiet, compact and outlined; the black button is the one firm commitment.
- **Shape:** gently rounded (8px), 36px tall, 14px side padding, 14px/500 label, 8px icon gap.
- **Default:** white with a hairline-strong stroke and hairline lift, ink label.
- **Primary:** ink fill and stroke, white label ("New enquiry"). One per view.
- **Hover / Focus:** default goes to soft-panel fill, primary to #1c2230; 150ms colour transitions; 2px violet focus outline at 2px offset; press scales to 0.97.
- **Small:** 32px tall, 12px padding, 13px label.
- **Send:** 32px ink square (8px corners) with an arrow; disabled shows mid grey.
- **Link button:** violet, 500 weight, 1px underline at 3px offset.

### Chips
- **Suggestion chips:** chip-grey fill, no border, body text at 13px/1.45, 10px corners; hover darkens to #eceef6. The suggested-task chips above the composer are white with a hairline-strong stroke so they read on the dock fade.
- **Status pills:** fully rounded, 12px/500 text on the matching tint with a leading 14px line icon.
- **Citation chip:** a superscript violet-on-violet-wash tag ("S01 p.14"), 11px/600, 5px corners; hover fills lavender.
- **Unknown marker:** dashed-hairline pill with a "?" icon, 12px muted text.

### Cards / Containers
- **Recommendation cards:** white, 1px hairline-strong stroke, 12px corners, 14px 16px padding, flat. The head row carries method · technique in 600 ink, the role pill and the evidence-strength pill; below it 2 to 3 cited reasons as bullets and the conditions. Not-recommended cards sit on soft-panel.
- **Premise panels:** a supported premise is a plain row; a contradicted or unverifiable one sits on the status tint (bad or warn) with a 1px tint-matched stroke, 10px corners, its pill on white.
- **Key-facts strip:** four stats (Primary method, Decision status, Open questions, Checks) in one 12px-cornered hairline box with hairline dividers; label 12px muted, value 15px/600 ink, one muted line below. Each stat opens its tab; a failing checks tally reads status-bad.
- **Notices:** soft-panel fill, 10px corners, 13px body text. "Report v2 ready" in the conversation is a notice with a small "Open" button; the client's question on the Overview is one too.

### Tabs
Lumeo-styled underline tabs in a sticky bar under the report header: 14px/500 labels in body grey (ink when active), 22px apart, a 44px row with a 1px hairline-strong rule below. A count after the label sits in a small soft-panel pill (violet-soft and violet when active, status-bad tint for a failing checks tally). The violet underline (2px) is one element that slides between tabs on transform (200ms, `--ease-out`), already in place on first paint. WAI-ARIA tablist: one tab in the tab order, ←/→/Home/End move and select, number keys 1 to 8 switch unless focus is in a field, menu or dialog. The active tab is kept in the URL hash (`#tab=methods`) and remembered per session. Panels cross-fade over 120ms of opacity only (no blur, no movement); the first paint and a stored report never animate.

### Tables
Report data tables use body-small text (14px), tabular numerals, 12px/600 muted header cells with a hairline-strong rule, hairline-ruled rows, no zebra and no outer border. The header row is sticky under the tab bar when the pane is wide enough to show the table whole. The candidate table shades each score (violet at 5 to 41% by value within its column), strikes blocked rows through, and states the rule engine's reasons and the evidence chips in the row itself.

### Inputs / Fields
- **Composer:** white, 1px hairline, 12px corners, 50px min height, composer-float shadow; attach square on the left, Web and Deep switches and the send button on the right. Textarea grows to 144px.
- **Focus:** border shifts to #8f75ec with the 3px violet focus halo; the textarea itself shows no outline.
- **Switches:** 34x20 track, grey off, violet on; white 16px knob glides 14px on the ease-out curve.

### Navigation
- **Rail:** 72px column, AFS emblem at top, 36px icon items 8px apart in body grey. The active item is violet on a soft pill, with a 3px violet bar on the rail's left edge; pill and bar are one element that glides between items (220ms ease-in-out). Help and API status sit at the bottom.
- **Top bar:** 80px, hairline bottom border; breadcrumb in body grey with the title in 500 ink, truncating.
- **Mobile:** the rail becomes a bottom tab bar with the same soft active pill.

### Disclosure Rows
Secondary report detail (methods, plan, checks) collapses into one-line rows ruled top and bottom by 1px hairlines: a 15px label, a muted one-line summary, and a chevron that rotates open. The body opens by animating grid rows 0fr to 1fr; 12px vertical padding per row.

### The Orb (signature)
A CSS-only glossy sphere: two radial gradients (orb-light → orb-mid → orb-deep) with a white specular ellipse, inner shade, and a lilac halo. 72px on home; enters with a 600ms blur-scale-in and breathes (scale 1.03 over 4s) while idle.

### The Submit Choreography (signature)
Greeting blurs out (220ms), the composer FLIPs from the home position into the conversation column, the enquiry bubble rises in, the report pane shows skeleton header and tab bar around the live pipeline, and when the report arrives the header block and the Overview blocks blur in 50ms apart (380ms each) while the direct answer's words reveal within 900ms in total, all on `cubic-bezier(0.16, 1, 0.3, 1)`. Other tabs never animate on switch beyond the 120ms opacity fade, and stored reports render at once. Disclosure rows open by animating grid rows 0fr to 1fr. Reduced motion collapses all of it to 120 to 150ms fades or no animation.

## Do's and Don'ts

### Do:
- **Do** keep every screen inside the white card on the #e6e6e6 ground, 24px corners, 12px inset on desktop.
- **Do** use violet (#6a42e0) for the active place, links and citations, and for nothing decorative.
- **Do** cite inline with the violet citation chip so every claim is one click from its source page.
- **Do** show decision state as a tinted status pill with an icon, before the prose.
- **Do** separate sections of a report tab with 28px of air and a 15px/600 label rather than boxes; the long tail goes in hairline-ruled one-line disclosure rows.
- **Do** put comparable data in tables with tabular numerals and a sticky header row, and link every summary to the tab that holds its detail.
- **Do** run motion on `cubic-bezier(0.16, 1, 0.3, 1)` and give every animation a reduced-motion fallback.
- **Do** reserve shadows for floating layers (menus, modals, drawers, composer).

### Don't:
- **Don't** bring back the dark navy dashboard or a chat side-drawer. Tabs are the report workspace's white underline tabs and nothing else; the conversation stays a calm thread.
- **Don't** animate tab switches beyond a 120ms opacity fade: scientists switch tabs all day.
- **Don't** put more than one ink-filled primary button in a view.
- **Don't** use the greeting's magenta-to-violet gradient text anywhere but the home greeting's emphasis words.
- **Don't** put assistant content on lavender; lavender is the user's voice.
- **Don't** add a second accent hue; colour beyond violet is status or the orb.
- **Don't** set text below 11px.
