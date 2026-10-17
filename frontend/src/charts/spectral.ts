// Pure trace builder for the spectral-window chart: method vs. fiber vs. instrument ranges on a
// log-scale µm axis, with cm⁻¹ shown alongside. Kept free of Plotly runtime imports so it can be
// unit-tested and the heavy plotly bundle is only loaded by the chart component.
import type { Annotation, Layout, Shape } from 'plotly.js'
import type { Finding, RangeUm, SpectralData } from '../types'

export type { SpectralData } from '../types'

/** Visible axis range in µm (deep UV to far mid-IR). */
export const AXIS_UM: RangeUm = [0.15, 30]
const TICKS_UM = [0.2, 0.5, 1, 2, 5, 10, 20]

export const FIBER_WINDOW_RULE = 'R-FIBER-WINDOW'

/** Plotly needs literal colours (no CSS variables); these mirror the brand / status palette. */
export const COLORS = {
  method: '#0050E0', // --afs-prism-500
  fiber: '#00E5FF', // --fiber-cyan
  client: '#FF8A00', // --fiber-orange
  instrument: '#D0508A', // --fiber-magenta
  overlap: '#3fcf8e', // --status-ok (green)
  gap: '#ff3b3b', // red
} as const

/** Horizontal bar trace (subset of Plotly's bar trace that this chart uses). */
export interface BarTrace {
  type: 'bar'
  orientation: 'h'
  name: string
  y: string[]
  base: number[]
  x: number[]
  width: number
  hovertext: string[]
  hoverinfo: 'text'
  marker: { color: string; opacity: number; line?: { color: string; width: number } }
  /** Card IDs per bar, so a click can open the evidence. */
  customdata: string[]
}

export interface FiberWindowGap {
  rule_id: string
  method: string
  fiber: string
  /** Gap in µm between the fiber window and the method range. */
  from: number
  to: number
  message: string
  evidence_ids: string[]
}

export interface SpectralHighlight {
  /** Candidate method IDs; when empty or absent every method is shown. */
  methods?: string[]
  /** Fiber family ID of the client's existing fiber, if known. */
  clientFiber?: string | null
  findings?: Finding[]
}

export interface SpectralFigure {
  traces: BarTrace[]
  layout: Partial<Layout>
  /** Row labels, top to bottom. */
  rows: string[]
  gaps: FiberWindowGap[]
}

export const umToCm1 = (um: number): number => 1e4 / um

const fmt = (n: number) => String(Number(n.toPrecision(3)))
const fmtCm1 = (um: number) => String(Math.round(umToCm1(um)))

/** "2.5–25 µm (4000–400 cm⁻¹)" */
export const formatRange = ([lo, hi]: RangeUm): string =>
  `${fmt(lo)}–${fmt(hi)} µm (${fmtCm1(lo)}–${fmtCm1(hi)} cm⁻¹)`

const intersect = ([a, b]: RangeUm, [c, d]: RangeUm): RangeUm | null => {
  const lo = Math.max(a, c)
  const hi = Math.min(b, d)
  return hi > lo ? [lo, hi] : null
}

/** Merge overlapping intervals. */
const union = (ranges: RangeUm[]): RangeUm[] => {
  const sorted = [...ranges].sort((p, q) => p[0] - q[0])
  const out: RangeUm[] = []
  for (const [lo, hi] of sorted) {
    const last = out.at(-1)
    if (last && lo <= last[1]) last[1] = Math.max(last[1], hi)
    else out.push([lo, hi])
  }
  return out
}

/** Parts of `range` not covered by `cover`. */
const uncovered = (range: RangeUm, cover: RangeUm): RangeUm[] => {
  const pieces: RangeUm[] = []
  if (cover[0] > range[0]) pieces.push([range[0], Math.min(cover[0], range[1])])
  if (cover[1] < range[1]) pieces.push([Math.max(cover[1], range[0]), range[1]])
  return pieces.filter(([lo, hi]) => hi > lo)
}

/** Client fiber family named by a fiber-window finding (the rule reads the client's existing assets). */
export const clientFiberFrom = (findings: Finding[] = []): string | null =>
  findings.find((f) => f.rule_id === FIBER_WINDOW_RULE && f.data?.fiber_family)?.data.fiber_family ?? null

/** Red gaps from blocking R-FIBER-WINDOW findings: the stretch between fiber window and method range. */
export function fiberWindowGaps(data: SpectralData, findings: Finding[] = []): FiberWindowGap[] {
  const gaps: FiberWindowGap[] = []
  for (const f of findings) {
    if (f.rule_id !== FIBER_WINDOW_RULE || f.severity !== 'blocking') continue
    const method = data.methods.find((m) => m.id === f.data?.method)
    const fiber = data.fibers.find((x) => x.id === f.data?.fiber_family)
    if (!method || !fiber) continue
    const [fLo, fHi] = fiber.range_um
    const [mLo, mHi] = method.range_um
    // Disjoint: the gap lies between the two ranges. Partial overlap: the uncovered method range.
    const pieces: RangeUm[] =
      fHi <= mLo ? [[fHi, mLo]] : mHi <= fLo ? [[mHi, fLo]] : uncovered(method.range_um, fiber.range_um)
    for (const [from, to] of pieces) {
      gaps.push({
        rule_id: f.rule_id,
        method: method.id,
        fiber: fiber.id,
        from,
        to,
        message: f.message,
        evidence_ids: f.evidence_ids,
      })
    }
  }
  return gaps
}

interface Bar {
  row: string
  range: RangeUm
  label: string
  cards: string[]
}

function barTrace(name: string, bars: Bar[], color: string, width: number, opacity: number): BarTrace {
  return {
    type: 'bar',
    orientation: 'h',
    name,
    y: bars.map((b) => b.row),
    base: bars.map((b) => b.range[0]),
    x: bars.map((b) => b.range[1] - b.range[0]),
    width,
    hovertext: bars.map((b) => `${b.label}: ${formatRange(b.range)}`),
    hoverinfo: 'text',
    marker: { color, opacity },
    customdata: bars.map((b) => b.cards.join(' ')),
  }
}

/**
 * Horizontal bar traces for candidate methods, fiber families, instruments and the client's fiber,
 * plus green overlap bars and red gap annotations for blocking fiber-window findings.
 */
export function buildSpectralTraces(data: SpectralData, highlight: SpectralHighlight = {}): SpectralFigure {
  const wanted = new Set(highlight.methods ?? [])
  const methods = wanted.size > 0 ? data.methods.filter((m) => wanted.has(m.id)) : data.methods
  const client = highlight.clientFiber ? data.fibers.find((f) => f.id === highlight.clientFiber) : undefined
  const clientRow = client ? `Client fiber: ${client.name}` : null

  const methodBars: Bar[] = methods.map((m) => ({ row: m.name, range: m.range_um, label: m.name, cards: m.cards }))
  const fiberBars: Bar[] = data.fibers.map((f) => ({ row: f.name, range: f.range_um, label: f.name, cards: [f.card] }))
  const instrumentBars: Bar[] = data.instruments.map((i) => ({
    row: `Instrument: ${i.name}`,
    range: i.range_um,
    label: i.name,
    cards: i.card ? [i.card] : [],
  }))

  // Overlap of each method with the client's fiber, or else with whatever the fiber families carry.
  const cover = client ? [client.range_um] : union(data.fibers.map((f) => f.range_um))
  const overlapBars: Bar[] = methods.flatMap((m) =>
    cover.flatMap((c) => {
      const o = intersect(m.range_um, c)
      return o ? [{ row: m.name, range: o, label: `${m.name} overlap`, cards: m.cards }] : []
    }),
  )

  const traces: BarTrace[] = [barTrace('Method range', methodBars, COLORS.method, 0.6, 0.55)]
  if (overlapBars.length > 0) {
    traces.push(
      barTrace(client ? 'Overlap with client fiber' : 'Overlap with fiber families', overlapBars, COLORS.overlap, 0.3, 0.95),
    )
  }
  traces.push(barTrace('Fiber family', fiberBars, COLORS.fiber, 0.6, 0.55))
  if (client && clientRow) {
    traces.push(
      barTrace('Client fiber', [{ row: clientRow, range: client.range_um, label: client.name, cards: [client.card] }], COLORS.client, 0.6, 0.8),
    )
  }
  if (instrumentBars.length > 0) traces.push(barTrace('Instrument range', instrumentBars, COLORS.instrument, 0.6, 0.55))

  const rows = [
    ...methodBars.map((b) => b.row),
    ...(clientRow ? [clientRow] : []),
    ...fiberBars.map((b) => b.row),
    ...instrumentBars.map((b) => b.row),
  ]

  const gaps = fiberWindowGaps(data, highlight.findings)
  const shapes: Partial<Shape>[] = gaps.map((g) => ({
    type: 'rect',
    xref: 'x',
    yref: 'paper',
    x0: g.from,
    x1: g.to,
    y0: 0,
    y1: 1,
    fillcolor: COLORS.gap,
    opacity: 0.35,
    line: { color: COLORS.gap, width: 2 },
  }))
  // Annotation x is in log10 units on a log axis (shapes take data units).
  const annotations: Partial<Annotation>[] = gaps.map((g, i) => ({
    xref: 'x',
    yref: 'paper',
    x: Math.log10(Math.sqrt(g.from * g.to)),
    y: 1 + i * 0.08,
    yanchor: 'bottom',
    showarrow: false,
    text: `${g.rule_id}: gap ${fmt(g.from)}–${fmt(g.to)} µm`,
    font: { color: COLORS.gap, size: 11 },
  }))

  const layout: Partial<Layout> = {
    barmode: 'overlay',
    showlegend: true,
    legend: { orientation: 'h', x: 0, xanchor: 'left', y: 1, yanchor: 'bottom' },
    margin: { l: 220, r: 16, t: 48 + gaps.length * 18, b: 96 },
    height: 120 + rows.length * 30,
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: 'Manrope, sans-serif', color: '#8b95c4', size: 12 },
    hovermode: 'closest',
    xaxis: {
      type: 'log',
      range: [Math.log10(AXIS_UM[0]), Math.log10(AXIS_UM[1])],
      tickvals: TICKS_UM,
      ticktext: TICKS_UM.map((um) => `${fmt(um)} µm<br>${fmtCm1(um)} cm⁻¹`),
      title: { text: 'Wavelength (µm, log scale) · wavenumber (cm⁻¹)' },
      gridcolor: 'rgba(139,149,196,0.2)',
      zeroline: false,
    },
    yaxis: {
      type: 'category',
      categoryorder: 'array',
      categoryarray: rows,
      autorange: 'reversed',
      automargin: true,
    },
    shapes,
    annotations,
  }

  return { traces, layout, rows, gaps }
}
