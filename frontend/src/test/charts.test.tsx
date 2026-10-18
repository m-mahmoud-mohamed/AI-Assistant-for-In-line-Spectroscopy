import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MethodHeatmap } from '../charts/MethodHeatmap'
import {
  buildSpectralTraces,
  COLORS,
  clientFiberFrom,
  fiberWindowGaps,
  umToCm1,
  type SpectralData,
} from '../charts/spectral'
import { SpectralWindowChart } from '../charts/SpectralWindowChart'
import findingsJson from './fixtures/findings.json'
import spectralJson from './fixtures/spectral.json'
import type { Candidate, Finding } from '../types'

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
    expect(within(figure).getByText(/Fiber-window gap/)).toBeInTheDocument()
    expect(within(figure).queryByText(/R-FIBER-WINDOW/)).toBeNull()
    expect(within(figure).getByText(/2\.4–2\.5 µm/)).toBeInTheDocument()
  })
})

describe('MethodHeatmap', () => {
  it('renders the candidate table, marks blocked rows and shows reasons and evidence cards without a click', () => {
    const onCite = vi.fn()
    render(<MethodHeatmap candidates={candidates} onCite={onCite} citations={{ 'S02-p13-water-petroleum': 'S02 p.13' }} />)
    const table = screen.getByRole('table', { name: /Candidate methods/ })
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Method',
      'Technique',
      'Status',
      'Why and evidence',
    ])
    const flRow = within(table).getByRole('row', { name: /Fluorescence/ })
    expect(within(flRow).getByText('Blocked')).toBeInTheDocument()
    // a blocked row says why in the table itself
    expect(flRow).toHaveTextContent('Fluorescence reports only a defined fluorescent species')

    const mirRow = within(table).getByRole('row', { name: /^MIR ATR probe/ })
    expect(within(mirRow).getByText('MIR')).toBeInTheDocument()
    expect(within(mirRow).queryByText('0.5')).toBeNull()
    expect(within(table).getAllByRole('row').slice(1).map((row) => within(row).getByRole('rowheader').textContent)).toEqual(candidates.map((c) => c.method))
    expect(mirRow).toHaveTextContent('A long mid-IR fiber link is not documented in the materials.')

    const cards = within(mirRow).getByRole('list', { name: 'Evidence cards for MIR · ATR probe' })
    expect(within(cards).getAllByRole('listitem')).toHaveLength(2)
    fireEvent.click(within(cards).getByRole('button', { name: 'Show source S02 p.13' }))
    expect(onCite).toHaveBeenCalledWith('S02-p13-water-petroleum')
  })

  it('names the stream only when the candidates span two or more', () => {
    const second = { ...candidates[0], key: 's2:NIR:x', stream_id: 's2' }
    const { unmount } = render(<MethodHeatmap candidates={candidates} />)
    expect(screen.queryByRole('columnheader', { name: 'Stream' })).toBeNull()
    unmount()
    render(<MethodHeatmap candidates={[...candidates, second]} streamNames={{ s1: 'Feed frame', s2: 'Outlet' }} />)
    expect(screen.getByRole('columnheader', { name: 'Stream' })).toBeInTheDocument()
    expect(screen.getAllByText('Feed frame').length).toBeGreaterThan(0)
    expect(screen.getByText('Outlet')).toBeInTheDocument()
  })

  it('says so when there are no candidates', () => {
    render(<MethodHeatmap candidates={[]} />)
    expect(screen.getByText(/No candidate methods/)).toBeInTheDocument()
  })
})
