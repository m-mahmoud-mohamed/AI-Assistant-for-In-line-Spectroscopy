// Design-review batch: human source titles and labels, no internal identifiers. (The report body's tab contents are tested in workspace.test.tsx.)
import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { PipelineGraph } from '../components/PipelineGraph'
import { EvidenceViewer } from '../components/EvidenceViewer'
import { SourcesList } from '../components/panel/SourcesList'
import { RecommendationItem } from '../components/report/Recommendations'
import { checkLabel, slotLabel } from '../labels'
import { applyEvents } from '../pipeline/reducer'
import { sourceTitle } from '../sourceTitle'
import mockReport from './fixtures/report.json'
import { routeFetch } from './helpers'
import type { ReportBody, RunEvent, SourceRef, Stage } from '../types'

const base = mockReport as ReportBody
const stream = (id: string, name: string) => ({
  id,
  name,
  targets: [],
  matrix: { value: 'powder', quote: null },
  optics: { value: 'unknown', quote: null },
})

// ---------------------------------------------------------------- 4. human source titles

describe('sourceTitle', () => {
  it('reads the card id slug as a topic', () => {
    expect(sourceTitle({ id: 'S01-p14-blend-potency', citation: 'S01 p.14' })).toBe('Blend potency')
    expect(sourceTitle({ id: 'TABLE-nir_diffuse_reflection_probe', citation: 'S01 Table 1 (p.6)' })).toBe('NIR diffuse reflection probe')
    expect(sourceTitle({ id: 'S01-p11-raman-fluorescence', citation: 'S01 p.11' })).toBe('Raman fluorescence')
    expect(sourceTitle({ id: 'TABLE-raman_raman_probe', citation: 'S01 Table 1 (p.6)' })).toBe('Raman probe')
  })

  it('uses the page title or the domain for web cards', () => {
    expect(sourceTitle({ id: 'EXT-1a2b', citation: 'doi.org', title: 'NIR in tablet feed frames', url: 'https://doi.org/10.1/x' })).toBe('NIR in tablet feed frames')
    expect(sourceTitle({ id: 'EXT-1a2b', citation: 'doi.org', url: 'https://www.sciencedirect.com/a' })).toBe('www.sciencedirect.com')
    expect(sourceTitle({ id: 'EXT-1a2b', citation: 'x', verification: { domain: 'doi.org' } })).toBe('doi.org')
  })

  it('falls back to a short form of the claim or quote', () => {
    expect(sourceTitle({ id: 'S01-p14', citation: 'S01 p.14', quote: 'determine "blend potency" - the precise concentration and uniformity of the API' })).toBe('Determine blend potency - the precise…')
    expect(sourceTitle({ id: 'S02', citation: 'S02', claim: 'Silica fibers transmit.' })).toBe('Silica fibers transmit')
  })
})

describe('source lists', () => {
  const list: SourceRef[] = [
    { id: 'S01-p14-blend-potency', citation: 'S01 p.14', quote: 'determine blend potency', scope: 'process_application', url: null },
    { id: 'TABLE-nir_diffuse_reflection_probe', citation: 'S01 Table 1 (p.6)', quote: 'NIR | probe', scope: 'method_general', url: null },
  ]

  it('rows are titled by topic with the citation in the meta line', () => {
    render(<SourcesList sources={list} counts={{ 'S01-p14-blend-potency': 3 }} onOpen={vi.fn()} />)
    const row = screen.getByRole('button', { name: /Blend potency/ })
    expect(within(row).getByText('Blend potency')).toHaveClass('sl-cite')
    expect(row.querySelector('.sl-meta')).toHaveTextContent('S01 p.14')
    expect(within(row).getByText('3 uses')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /NIR diffuse reflection probe/ })).toBeInTheDocument()
  })

  it('the evidence viewer shows the topic as its title, the citation under it and never the raw card id', () => {
    routeFetch({})
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <EvidenceViewer cardId="S01-p14-blend-potency" fallback={list[0]} />
      </QueryClientProvider>,
    )
    expect(screen.getByRole('heading', { name: 'Blend potency' })).toBeInTheDocument()
    expect(screen.getByText('S01 p.14')).toBeInTheDocument()
    expect(screen.queryByText('S01-p14-blend-potency')).toBeNull()
  })
})

// ---------------------------------------------------------------- 5. no internal identifiers

describe('human labels instead of ids', () => {
  it('names checks and slots', () => {
    expect(checkLabel('C-IDS')).toBe('Citation ids')
    expect(checkLabel('P-NO-NUMBERS')).toBe('No invented numbers')
    expect(checkLabel('R-SAMPLE-GEOMETRY')).toBe('Sample geometry')
    expect(slotLabel('streams.s1.matrix')).toBe('Matrix')
    expect(slotLabel('process_conditions')).toBe('Process conditions')
    expect(slotLabel('streams.s1.optics')).toBe('Optical state')
  })

  it('a single stream is never labelled; two or more are named', () => {
    const rec = { ...base.recommendations[0], applies_to: ['s1'] }
    const { rerender } = render(<RecommendationItem rec={rec} streams={[stream('s1', 'main')]} />)
    expect(screen.queryByText(/streams:/)).toBeNull()
    expect(screen.queryByText(/main/)).toBeNull()
    rerender(<RecommendationItem rec={rec} streams={[stream('s1', 'Feed frame'), stream('s2', 'Outlet')]} />)
    expect(screen.getByText('for Feed frame')).toBeInTheDocument()
    expect(screen.queryByText(/\bs1\b/)).toBeNull()
  })

  it('the pipeline graph groups verifier issues by check with a human name and a count', () => {
    const event = (seq: number, type: RunEvent['type'], stage: Stage, payload: Record<string, unknown> = {}): RunEvent => ({ type, run_id: 'r', seq, ts: 1_760_000_000 + seq, stage, payload })
    const state = applyEvents([
      event(1, 'stage_started', 'verify'),
      ...[2, 3, 4, 5].map((n) => event(n, 'issue_found', 'verify', { check_id: 'C-IDS', path: `x[${n}]`, message: 'cites a card that is not in the pack', severity: 'error' })),
      event(6, 'issue_found', 'verify', { check_id: 'P-LENGTH', path: '', message: 'too long', severity: 'warning' }),
      event(7, 'stage_completed', 'verify', { seconds: 1 }),
    ])
    render(<PipelineGraph state={state} />)
    const graph = screen.getByRole('group', { name: 'Pipeline graph' })
    expect(within(graph).getByText('Citation ids')).toBeInTheDocument()
    expect(within(graph).getByText('· 4 issues')).toBeInTheDocument()
    expect(within(graph).getByText('Length limit')).toBeInTheDocument()
    expect(graph.textContent).not.toMatch(/C-IDS|P-LENGTH/)
  })
})
