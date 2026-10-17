import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MethodHeatmap } from '../charts/MethodHeatmap'
import { SCORE_COLUMNS, scoreMatrix } from '../charts/scores'
import {
  buildSpectralTraces,
  COLORS,
  clientFiberFrom,
  fiberWindowGaps,
  umToCm1,
  type SpectralData,
} from '../charts/spectral'
import { SpectralWindowChart } from '../charts/SpectralWindowChart'
import { ReportView } from '../components/report/ReportView'
import findingsJson from './fixtures/findings.json'
import reportJson from './fixtures/report.json'
import spectralJson from './fixtures/spectral.json'
import type { Candidate, Finding, ReportBody, RuleFindings } from '../types'

// jsdom cannot run plotly; the chart component is tested for its text output only.
vi.mock('plotly.js-dist-min', () => ({ default: {} }))
vi.mock('react-plotly.js/factory', () => ({ default: () => () => <div data-testid="plot" /> }))

const spectral = spectralJson as unknown as SpectralData
const findings = findingsJson.findings as Finding[]
const candidates = findingsJson.candidates as Candidate[]

const nonBlocking = findings.filter((f) => f.severity !== 'blocking')

describe('buildSpectralTraces', () => {
  const fig = buildSpectralTraces(spectral, { methods: ['NIR', 'MIR'], clientFiber: 'visnir_silica', findings })

  it('uses a log-scale µm axis from 0.15 to 30 with cm⁻¹ tick labels', () => {
    const x = fig.layout.xaxis!
    expect(x.type).toBe('log')
    expect(x.range![0]).toBeCloseTo(Math.log10(0.15))
    expect(x.range![1]).toBeCloseTo(Math.log10(30))
    const ticks = x.ticktext as string[]
    expect(ticks.length).toBe((x.tickvals as number[]).length)
    expect(ticks.every((t) => t.includes('µm') && t.includes('cm⁻¹'))).toBe(true)
    expect(umToCm1(2.5)).toBe(4000)
  })

  it('draws horizontal bars for candidate methods, fiber families and the client fiber', () => {
    expect(fig.traces.every((t) => t.type === 'bar' && t.orientation === 'h')).toBe(true)
    const rows = fig.traces.flatMap((t) => t.y as string[])
    expect(rows).toContain('NIR spectroscopy')
    expect(rows).toContain('Mid-infrared (IR) spectroscopy')
    // only the candidate methods are shown
    expect(rows).not.toContain('Fluorimetry')
    for (const f of spectral.fibers) expect(rows).toContain(f.name)
    expect(rows).toContain('Client fiber: VIS-NIR silica fiber')

    const methods = fig.traces.find((t) => t.name === 'Method range')!
    expect(methods.base).toEqual([0.78, 2.5])
    expect(methods.x).toEqual([2.5 - 0.78, 25 - 2.5])
    const hover = methods.hovertext as string[]
    expect(hover[1]).toContain('2.5–25 µm')
    expect(hover[1]).toContain('4000–400 cm⁻¹')
  })

  it('shades the overlap with the client fiber green', () => {
    const overlap = fig.traces.find((t) => t.name === 'Overlap with client fiber')!
    expect(overlap.y).toEqual(['NIR spectroscopy'])
    expect(overlap.base).toEqual([0.78])
    expect((overlap.x as number[])[0]).toBeCloseTo(2.4 - 0.78)
    expect((overlap.marker as { color: string }).color).toMatch(/^#0f9d6b/i)
  })

  it('draws a red gap with the rule id for a blocked silica → MIR case', () => {
    const gaps = fiberWindowGaps(spectral, findings)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ rule_id: 'R-FIBER-WINDOW', method: 'MIR', fiber: 'visnir_silica', from: 2.4, to: 2.5 })

    const red = fig.layout.shapes!.filter((s) => s.line?.color === COLORS.gap)
    expect(red).toHaveLength(1)
    expect(red[0]).toMatchObject({ type: 'rect', x0: 2.4, x1: 2.5, yref: 'paper' })
    const notes = fig.layout.annotations!.map((a) => a.text)
    expect(notes.some((t) => t?.includes('R-FIBER-WINDOW'))).toBe(true)
  })

  it('draws no gap without a blocking fiber-window finding, and no client row without a client fiber', () => {
    const plain = buildSpectralTraces(spectral, { methods: ['MIR'], findings: nonBlocking })
    expect(plain.layout.shapes ?? []).toHaveLength(0)
    expect(plain.layout.annotations ?? []).toHaveLength(0)
    expect(plain.traces.flatMap((t) => t.y as string[]).some((r) => r.startsWith('Client fiber'))).toBe(false)
    // without a client fiber, overlap is the part of the method range that some fiber family carries
    const overlap = plain.traces.find((t) => t.name === 'Overlap with fiber families')!
    expect(overlap.base).toEqual([2.5])
    expect((overlap.x as number[])[0]).toBeCloseTo(18 - 2.5)
  })

  it('shows every method when no candidates are given', () => {
    const all = buildSpectralTraces(spectral, {})
    const methods = all.traces.find((t) => t.name === 'Method range')!
    expect(methods.y).toHaveLength(spectral.methods.length)
  })

  it('reads the client fiber from the fiber-window finding', () => {
    expect(clientFiberFrom(findings)).toBe('visnir_silica')
    expect(clientFiberFrom(nonBlocking)).toBeNull()
  })
})

describe('SpectralWindowChart', () => {
  it('gives a text summary that names the blocking gap', () => {
    render(<SpectralWindowChart data={spectral} methods={['MIR']} clientFiber="visnir_silica" findings={findings} />)
    const figure = screen.getByRole('figure', { name: /Spectral windows/ })
    expect(within(figure).getByText(/R-FIBER-WINDOW/)).toBeInTheDocument()
    expect(within(figure).getByText(/2\.4–2\.5 µm/)).toBeInTheDocument()
  })
})

describe('ReportView wiring', () => {
  const props = { report: reportJson as ReportBody, spectral, rules: findingsJson as RuleFindings }

  it('shows the spectral chart in its own section', () => {
    render(<ReportView {...props} />)
    const section = screen.getByRole('region', { name: 'Spectral windows' })
    expect(within(section).getByRole('figure', { name: /Spectral windows/ })).toBeInTheDocument()
    expect(within(section).getByText(/R-FIBER-WINDOW/)).toBeInTheDocument()
  })

  it('shows the score heatmap in the Method comparison section', () => {
    render(<ReportView {...props} />)
    const section = screen.getByRole('region', { name: 'Method comparison' })
    expect(within(section).getByRole('table', { name: /Candidate method scores/ })).toBeInTheDocument()
  })
})

describe('scoreMatrix', () => {
  const m = scoreMatrix(candidates)

  it('gives methods × fit, optics, evidence, link, total', () => {
    expect(m.columns).toEqual(SCORE_COLUMNS)
    expect(m.columns).toEqual(['fit', 'optics', 'evidence', 'link', 'total'])
    expect(m.rows).toHaveLength(candidates.length)
    for (const r of m.rows) expect(r.cells.map((c) => c.column)).toEqual([...SCORE_COLUMNS])
    const mir = m.rows.find((r) => r.method === 'MIR')!
    expect(mir.label).toBe('MIR · ATR probe')
    expect(mir.cells.map((c) => c.value)).toEqual([2, 1, 1, 0.5, 4.5])
  })

  it('marks blocked rows and sorts them last; open rows by total', () => {
    const fl = m.rows.find((r) => r.method === 'Fluorescence')!
    expect(fl.blocked).toBe(true)
    expect(m.rows.at(-1)).toBe(fl)
    const totals = m.rows.filter((r) => !r.blocked).map((r) => r.cells.at(-1)!.value)
    expect(totals).toEqual([...totals].sort((a, b) => b - a))
  })

  it('puts the reasons in every cell tooltip', () => {
    const mir = m.rows.find((r) => r.method === 'MIR')!
    for (const c of mir.cells) expect(c.tooltip).toContain('A long mid-IR fiber link is not documented')
    expect(mir.cells.find((c) => c.column === 'link')!.tooltip).toContain('link: 0.5')
    expect(mir.cells.find((c) => c.column === 'total')!.tooltip).toContain('2 + 1 + 1 + 0.5 = 4.5')
    const nir = m.rows.find((r) => r.method === 'NIR')!
    expect(nir.cells[0].tooltip).toContain('No deductions recorded')
    const fl = m.rows.find((r) => r.method === 'Fluorescence')!
    expect(fl.cells[0].tooltip).toContain('Blocked')
  })

  it('normalises cell intensity per column', () => {
    const mir = m.rows.find((r) => r.method === 'MIR')!
    expect(mir.cells.find((c) => c.column === 'link')!.intensity).toBeCloseTo(0.5)
    expect(mir.cells.find((c) => c.column === 'fit')!.intensity).toBeCloseTo(1)
    expect(scoreMatrix([]).rows).toEqual([])
  })
})

describe('MethodHeatmap', () => {
  it('renders the matrix, marks blocked rows and opens evidence cards on row click', () => {
    const onCite = vi.fn()
    render(<MethodHeatmap candidates={candidates} onCite={onCite} citations={{ 'S02-p13-water-petroleum': 'S02 p.13' }} />)
    const table = screen.getByRole('table', { name: /Candidate method scores/ })
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Method',
      'Fit',
      'Optics',
      'Evidence',
      'Link',
      'Total',
    ])
    const flRow = within(table).getByRole('row', { name: /Fluorescence · fluorimetric probe/ })
    expect(within(flRow).getByText('Blocked')).toBeInTheDocument()

    const mirRow = within(table).getByRole('row', { name: /MIR · ATR probe/ })
    expect(within(mirRow).getByText('0.5').closest('td')).toHaveAttribute(
      'title',
      expect.stringContaining('A long mid-IR fiber link is not documented'),
    )

    const toggle = within(mirRow).getByRole('button', { name: /MIR · ATR probe/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const cards = screen.getByRole('list', { name: 'Evidence cards for MIR · ATR probe' })
    expect(within(cards).getAllByRole('listitem')).toHaveLength(2)
    fireEvent.click(within(cards).getByRole('button', { name: 'Show source S02 p.13' }))
    expect(onCite).toHaveBeenCalledWith('S02-p13-water-petroleum')
  })

  it('says so when there are no candidates', () => {
    render(<MethodHeatmap candidates={[]} />)
    expect(screen.getByText(/No scored candidates/)).toBeInTheDocument()
  })
})
