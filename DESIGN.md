---
name: PRISM
description: AFS in-line spectroscopy assistant; one calm thread, answer first, evidence one click away.
colors:
  ground: "#e6e6e6"
  card: "#ffffff"
  soft: "#f6f7fb"
  chip: "#f5f6fa"
  hairline: "#e9ecf2"
  hairline-strong: "#e4e7ee"
  hairline-panel: "#eceff4"
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
  source-card:
    backgroundColor: "{colors.soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "14px 16px"
  chip:
    backgroundColor: "{colors.chip}"
    textColor: "{colors.body}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
  panel-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.body}"
    rounded: "{rounded.xl}"
    padding: "20px"
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

PRISM is a light, quiet working surface: one white app card (24px corners) floating on a flat grey ground, a narrow icon rail on the left, a hairline top bar, and a single centred reading column where the enquiry, the pipeline, the sources and the cited assessment flow top to bottom as one thread. On wide screens a 300px column of white panel cards (Sources, Suggested tasks, Suggested questions) sits beside the thread as part of the same centred block. The world is pinned by the user to the Dribbble reference "Lumeo – AI Assistant Result", and the build follows it closely: Inter grotesk, ink-and-grey text, a single violet accent, a lavender user bubble, a black primary button, and a glossy purple orb as the only illustrative object.

Density is moderate and readable rather than dashboard-dense. Hierarchy comes from weight and ink colour, not from boxes: sections are separated by 28px of air, the report reads as prose with bullets, and secondary detail collapses into one-line disclosure rows. Colour is spent on meaning: violet for the active place and for links and citations, the quiet status trio (green, amber, red on tinted fills) for decision state, and the orb gradient for the assistant's presence. The old dark navy dashboard with tabs and a chat side-drawer is the confirmed rejection.

Motion is the signature. Submitting an enquiry blurs the greeting out, glides the composer to the bottom (FLIP), raises the lavender bubble, fills the panel with shimmering skeletons, and then blurs sources and results in word by word, all on one ease-out curve. Every motion has a reduced-motion fallback that collapses to a short fade or nothing.

**Key Characteristics:**
- White card (24px radius) on a #e6e6e6 ground; 12px inset; full-bleed below 1024px.
- One violet accent; one black primary button with 8px corners; tinted status pills.
- Inter at 15px/1.6 body; weight and ink, not size jumps, carry hierarchy.
- Flat surfaces separated by 1px cool hairlines; shadows only on floating layers.
- Blur-in, word-reveal and FLIP motion on a single ease-out curve, with reduced-motion fallbacks.

## Colors

A near-monochrome cool-grey world with one violet voice and an orb-gradient garnish.

### Primary
- **Signal Violet** (`violet`): the active rail bar and active icon, links and link buttons, citation chip text, the on state of switches, focus outline, caret and `accent-color`. Hover deepens to `violet-hover`.
- **Violet Wash** (`violet-soft`): fill behind citation chips and info pills; never a surface.
- **Lavender Bubble** (`bubble`, text `bubble-ink`): the user's enquiry bubble and the text selection colour; nothing else.

### Secondary
- **Source Star Blue** (`star`): the four-point star glyph on internal source cards only (web sources use body grey).

### Tertiary
- **Orb Gradient** (`orb-light` → `orb-mid` → `orb-deep`): the glossy orb, its specular highlight and lilac halo.
- **Greeting Emphasis** (`magenta` → `purple`): the gradient carried by the emphasis words of the home greeting. This is a sanctioned exception pinned by the reference, used in exactly that one place.

### Neutral
- **Ground Grey** (`ground`): the page behind the app card.
- **Card White** (`card`): the app card, buttons, composer, panel cards, menus, modals.
- **Soft Panel** (`soft`): source cards, hover fills, the rail's active pill, notices, keyboard hints.
- **Chip Grey** (`chip`): suggestion chips and suggested-question rows.
- **Hairlines** (`hairline`, `hairline-strong`, `hairline-panel`, `rail-sep`): 1px dividers and button/card strokes; the strong variant on buttons and the top bar, the panel variant on panel cards.
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
- **Title** (600, 19px, 1.3): thread section titles (Sources, Results), each led by a 20px line icon.
- **Title Small** (500, 17px, 1.3): panel card titles.
- **Body** (400, 15px, 1.6): report prose, the bubble, the composer, step lines. The reading column is 634px wide.
- **Body Small** (400, 14px, 1.5): buttons, panel lede, pipeline summary line, breadcrumb-adjacent text.
- **Label** (500, 13px): chips, source card meta, notes.
- **Caption** (500, 12px): status pills, tertiary actions; 11px only for the citation chip and claim markers.

### Named Rules
**The Weight Not Size Rule.** In-report sub-headings (Recommendations, Methods) stay at body size (15px) and step up to 600 ink. Size jumps are reserved for the greeting, page headings and section titles.

**The Tabular Rule.** Tables, times and counts use tabular numerals.

## Layout

The app is a flex shell inside a white card inset 12px from the viewport (`--card-inset`). The rail is 72px wide with a 1px separator; the top bar is 80px tall with 28px side padding: mode and report-version selects on the left, a centred "Assessments / title" breadcrumb, and Search, Export and the black "New enquiry" button on the right.

The thread is one column 634px wide (`--col-w`). With the side panel present, the column and the 300px panel (58px apart) are centred together as one block; the thread starts at the top with 24px top padding, 28px between thread blocks, and 150px of bottom padding so content clears the docked composer. A 170px white-to-#f6f6f6 fade sits under the docked composer, which floats 24px from the card's bottom edge.

On home, the orb (72px), greeting and composer form one group resting at roughly 45% of the card height (4:6 flex split above and below), not dead centre.

Spacing rhythm: 8 / 12 / 16 / 20 / 24 / 28px. Section gap 28px, intra-section 8 to 14px, panel cards padded 20px with 20px between.

Responsive behaviour:
- **Below 1180px**: the side panel becomes a 360px slide-over from the right, opened from a top-bar button, with a scrim.
- **Below 1024px**: the card goes full-bleed with no radius.
- **Below 900px**: secondary top-bar buttons drop their labels.
- **Below 760px**: the rail becomes a bottom tab bar, the top bar shrinks to 64px with icon-only buttons and no breadcrumb, and the panel becomes a bottom sheet with a drag handle.
- **Below 640px**: source cards go to two columns, the composer wraps its controls onto a second row, the greeting drops to 28px.

## Elevation & Depth

Flat by default. Resting surfaces (card, source cards, panel cards, chips) carry no shadow; depth comes from the grey ground under the white card and from soft-panel fills against white. Shadows appear only on things that float: menus, modals, drawers, the slide-over panel, tooltips, and the composer, which hovers over the thread. Shadows are cool (rgba(16,24,40,…)) and diffuse, except the composer's faint violet-tinted lift. Buttons carry a 1px hairline lift.

### Shadow Vocabulary
- **Hairline lift** (`box-shadow: 0 1px 2px rgba(16, 24, 40, 0.05)`): outline buttons.
- **Composer float** (`box-shadow: 0 8px 24px rgba(106, 66, 224, 0.06), 0 1px 2px rgba(16, 24, 40, 0.04)`): the composer at rest.
- **Focus halo** (`box-shadow: 0 0 0 3px rgba(106, 66, 224, 0.16)`): composer and text areas on focus, with the border shifting to #8f75ec.
- **Menu** (`box-shadow: 0 12px 32px rgba(16, 24, 40, 0.12), 0 2px 6px rgba(16, 24, 40, 0.06)`): dropdowns and export menu.
- **Modal** (`box-shadow: 0 24px 64px rgba(16, 24, 40, 0.18), 0 4px 12px rgba(16, 24, 40, 0.08)`): modals and the command palette.
- **Drawer** (`box-shadow: -16px 0 48px rgba(16, 24, 40, 0.14)`): right-side drawers and the slide-over panel.
- **Orb glow** (`box-shadow: inset -7px -10px 16px rgba(78, 14, 150, 0.45), inset 5px 6px 12px rgba(255, 220, 255, 0.35), 0 18px 50px rgba(193, 61, 252, 0.35)`): the orb only.

### Named Rules
**The Float-Only Shadow Rule.** A surface gets a shadow only if it floats above the thread. Cards inside the thread and panel are flat.

## Shapes

Soft, consistent rounded rectangles; nothing sharp, nothing fully pill-shaped except status pills and switches. The app card is 24px; panel cards and modals 16px; the composer, source cards, menus and question rows 12px; chips, rail items and skeletons 10px; buttons and the send button 8px; small inline marks (kbd hints, priority tags) 6px; the citation chip 5px. The user bubble is 16px with its bottom-right corner tucked to 4px, pointing at its sender. Strokes are 1px cool hairlines; dashed hairlines mark unknowns. The only illustration is the Sources card's faint 29px grid with a line-drawn folder, radially masked (a sanctioned exception from the reference).

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
- **Suggestion chips and question rows:** chip-grey fill, no border, body text at 13px/1.45, 10px (chips) or 12px (panel) corners; hover darkens to #eceef6.
- **Status pills:** fully rounded, 12px/500 text on the matching tint with a leading 14px line icon.
- **Citation chip:** a superscript violet-on-violet-wash tag ("S01 p.14"), 11px/600, 5px corners; hover fills lavender.
- **Unknown marker:** dashed-hairline pill with a "?" icon, 12px muted text.

### Cards / Containers
- **Source cards:** soft-panel fill, no border, 12px corners, 14px 16px padding, 76px min height; title in ink, meta row with the star glyph, citation and use count. Four across (three plus a 72px "+N More" tile), two below 640px.
- **Panel cards:** white, 1px hairline-panel stroke, 16px corners, 20px padding, 17px titles, flat.
- **Notices:** soft-panel fill, 10px corners, 13px body text.

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
Greeting blurs out (220ms), the composer FLIPs from the home position to the dock, the enquiry bubble rises in, panel skeletons shimmer, then section titles and text reveal word by word (opacity, 0.35em rise, 6px blur, 450ms) on `cubic-bezier(0.16, 1, 0.3, 1)`. Disclosure rows open by animating grid rows 0fr to 1fr. Reduced motion collapses all of it to 120 to 150ms fades or no animation.

## Do's and Don'ts

### Do:
- **Do** keep every screen inside the white card on the #e6e6e6 ground, 24px corners, 12px inset on desktop.
- **Do** use violet (#6a42e0) for the active place, links and citations, and for nothing decorative.
- **Do** cite inline with the violet citation chip so every claim is one click from its source page.
- **Do** show decision state as a tinted status pill with an icon, before the prose.
- **Do** separate top-level thread sections with 28px of air and a 19px/600 title rather than boxes; collapsed detail goes in hairline-ruled one-line disclosure rows.
- **Do** run motion on `cubic-bezier(0.16, 1, 0.3, 1)` and give every animation a reduced-motion fallback.
- **Do** reserve shadows for floating layers (menus, modals, drawers, composer).

### Don't:
- **Don't** bring back the dark navy dashboard, tabs, or a chat side-drawer; the thread is the product.
- **Don't** put more than one ink-filled primary button in a view.
- **Don't** use the greeting's magenta-to-violet gradient text anywhere but the home greeting's emphasis words.
- **Don't** put assistant content on lavender; lavender is the user's voice.
- **Don't** add a second accent hue; colour beyond violet is status or the orb.
- **Don't** set text below 11px.
