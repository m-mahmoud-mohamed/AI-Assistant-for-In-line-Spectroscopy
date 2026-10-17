// Design-review batch: finished reports rest on the answer, calmer report body, collapsed rows, human source titles,
// no internal identifiers, no repeated content.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PipelineGraph } from '../components/PipelineGraph'
import { EvidenceViewer } from '../components/EvidenceViewer'
import { SourcesList } from '../components/panel/SourcesList'
import { ReportView, type ReportViewData } from '../components/report/ReportView'
import { RecommendationItem } from '../components/report/Recommendations'
import { checkLabel, slotLabel } from '../labels'
import { applyEvents } from '../pipeline/reducer'
import { sourceTitle } from '../sourceTitle'
import mockFindings from './fixtures/findings.json'
import mockReport from './fixtures/report.json'
import mockSpectral from './fixtures/spectral.json'
import { FakeEventSource, detail, renderApp, routeFetch } from './helpers'
import type { ReportBody, RuleFindings, RunEvent, SourceRef, Stage } from '../types'

const base = mockReport as ReportBody
const sources: SourceRef[] = [{ id: 'S01-p17-nir-reflection-opaque', citation: 'S01 p.17', quote: 'Verbatim quote.', scope: 'method_general', url: null }]

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
    const { rerender } = render(<RecommendationItem rec={rec} index={0} streams={[stream('s1', 'main')]} />)
    expect(screen.queryByText(/streams:/)).toBeNull()
    expect(screen.queryByText(/main/)).toBeNull()
    rerender(<RecommendationItem rec={rec} index={0} streams={[stream('s1', 'Feed frame'), stream('s2', 'Outlet')]} />)
    expect(screen.getByText('for Feed frame')).toBeInTheDocument()
    expect(screen.queryByText(/\bs1\b/)).toBeNull()
  })

  const withFacts: ReportViewData = {
    ...base,
    streams: [stream('s1', 'main')],
    requirements: {
      ...base.requirements,
      stated_facts: [
        { slot: 'streams.s1.targets', value: 'API concentration', quote: 'API concentration changes', stream_id: 's1' },
        { slot: 'streams.s1.matrix', value: 'powder', quote: 'powder blend', stream_id: 's1' },
        { slot: 'distance', value: 'at_process', quote: 'in the feed frame', stream_id: null },
      ],
    },
  }

  it('What the client told us uses human labels and no stream keys', () => {
    render(<ReportView report={withFacts} />)
    fireEvent.click(screen.getByRole('button', { name: /What the client told us/ }))
    const section = screen.getByRole('region', { name: /What the client told us/ })
    expect(section).toHaveTextContent('Target:')
    expect(section).toHaveTextContent('Matrix:')
    expect(section).toHaveTextContent('Distance to the analyser:')
    expect(section.textContent).not.toMatch(/streams\.s1|\bmain\b/)
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

// ---------------------------------------------------------------- 2/3/6. calmer body, collapsed rows, no repeats

describe('report body', () => {
  const unknowns = [
    { slot: 'process_conditions', stream_id: null, why_it_matters: 'Needed for the feasibility plan and acceptance criteria.' },
    { slot: 'concentration_range', stream_id: null, why_it_matters: 'Needed for the feasibility plan and acceptance criteria.' },
    { slot: 'streams.s1.optics', stream_id: 's1', why_it_matters: 'Not stated by the client.' },
  ]
  const report: ReportViewData = {
    ...base,
    streams: [stream('s1', 'main')],
    client_question: ['We want to assess whether a fibre measurement could follow API changes.'],
    requirements: { ...base.requirements, key_unknowns: unknowns },
  }

  it('leads with the answer, recommendations and questions; everything else is a one-line row', () => {
    render(<ReportView report={{ ...report, sources }} />)
    for (const open of ['Recommendations', 'Feasibility plan', 'Questions for the client']) {
      expect(screen.getByRole('heading', { name: open })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: new RegExp(`^${open}`) })).toBeNull()
    }
    const rows = ['Measurement concept', 'Spectral windows', 'What the client told us', 'Key unknowns', 'Risks & assumptions', 'Limitations', 'Decision basis']
    for (const label of rows) {
      const row = screen.queryByRole('button', { name: new RegExp(`^${label}`) })
      if (!row) continue // sections the fixture does not have
      expect(row).toHaveAttribute('aria-expanded', 'false')
    }
    const concept = screen.getByRole('button', { name: /^Measurement concept/ })
    expect(concept).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Probe geometry')).toBeNull()
    fireEvent.click(concept)
    expect(concept).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Probe geometry')).toBeInTheDocument()
  })

  it('Premise checks stays open when a premise is contradicted or unverifiable, and folds when all are supported', () => {
    const premise = (verdict: 'SUPPORTED' | 'CONTRADICTED' | 'UNVERIFIABLE') => ({ premise: `p-${verdict}`, verdict, explanation: [] })
    const { unmount } = render(<ReportView report={{ ...report, premise_checks: [premise('SUPPORTED'), premise('UNVERIFIABLE')] }} />)
    expect(screen.getByRole('heading', { name: 'Premise checks' })).toBeInTheDocument()
    expect(screen.getByText('p-UNVERIFIABLE')).toBeInTheDocument()
    unmount()
    render(<ReportView report={{ ...report, premise_checks: [premise('SUPPORTED')] }} />)
    const row = screen.getByRole('button', { name: /^Premise checks/ })
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(row).toHaveTextContent('1 supported')
    expect(screen.queryByText('p-SUPPORTED')).toBeNull()
  })

  it('shows no "You asked" box: the bubble already carries the question', () => {
    render(<ReportView report={report} />)
    expect(screen.queryByText('You asked')).toBeNull()
    expect(screen.queryByText(/could follow API changes/)).toBeNull()
  })

  it('Key unknowns shows a shared reason once above the list it covers', () => {
    render(<ReportView report={report} />)
    fireEvent.click(screen.getByRole('button', { name: /^Key unknowns/ }))
    const section = screen.getByRole('region', { name: /Key unknowns/ })
    expect(within(section).getAllByText(/Needed for the feasibility plan and acceptance criteria/)).toHaveLength(1)
    expect(within(section).getByText('Needed for the feasibility plan and acceptance criteria:')).toBeInTheDocument()
    expect(within(section).getByText('Process conditions')).toBeInTheDocument()
    expect(within(section).getByText('Concentration range')).toBeInTheDocument()
    expect(within(section).getByText('Optical state')).toBeInTheDocument()
    expect(section.textContent).not.toMatch(/streams\.s1/)
  })

  it('claim chips: AFS is unmarked, the rest stay', () => {
    render(<ReportView report={{ ...report, sources }} />)
    expect(document.querySelector('[data-claim="AFS"]')).toBeNull()
    expect(document.querySelector('[data-claim="ASSUMPTION"], [data-claim="PROPOSAL"], [data-claim="UNKNOWN"], [data-claim="CLIENT"]')).not.toBeNull()
  })

  it('printing opens every row', () => {
    render(<ReportView report={report} />)
    expect(screen.queryByText('Probe geometry')).toBeNull()
    act(() => void window.dispatchEvent(new Event('beforeprint')))
    expect(screen.getByText('Probe geometry')).toBeInTheDocument()
    act(() => void window.dispatchEvent(new Event('afterprint')))
  })

  it('the findings-fed method comparison is reachable behind its row', () => {
    render(<ReportView report={report} rules={mockFindings as RuleFindings} spectral={mockSpectral as never} />)
    const row = screen.getByRole('button', { name: /^Method comparison/ })
    expect(row).toHaveTextContent(/candidates? · highest:/)
    fireEvent.click(row)
    expect(screen.getByRole('table', { name: /Candidate method scores/ })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------- 1. finished reports rest on the answer

describe('thread scroll', () => {
  let ros: (() => void)[] = []
  const scrollTo = vi.fn()
  beforeEach(() => {
    ros = []
    scrollTo.mockClear()
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          ros.push(cb)
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 3000 })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 700 })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 3000 })
    HTMLElement.prototype.scrollTo = scrollTo as never
  })
  afterEach(() => {
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo
    for (const k of ['scrollHeight', 'clientHeight', 'offsetHeight']) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k]
  })

  async function openReport() {
    routeFetch({
      '/api/sessions': () => [detail()],
      '/api/kb/spectral': () => mockSpectral,
      '/api/sessions/s9': () => detail(),
      '/api/runs/r7/report': () => ({ ...mockReport, run_id: 'r7', case_id: '', title: 'Dairy line fat content', sources, findings: mockFindings, scope: { label: 'IN_SCOPE', reason: '', suggestions: [], tier: 'signals' } }),
    })
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'History' }))
    fireEvent.click(await screen.findByRole('button', { name: /Dairy line fat content/ }))
    await screen.findByRole('region', { name: 'Recommendations' })
  }
  const grow = () => act(() => void ros.forEach((cb) => cb()))
  const lastTop = () => (scrollTo.mock.calls.at(-1)?.[0] as { top: number } | undefined)?.top

  it('rests on the enquiry, not the tail, while the reveal keeps growing the content', async () => {
    await openReport()
    expect(lastTop()).toBe(0)
    // well past the old 800 ms window that let the follow resume
    await new Promise((r) => setTimeout(r, 900))
    scrollTo.mockClear()
    grow()
    grow()
    expect(scrollTo.mock.calls.some((c) => (c[0] as { top: number }).top > 0)).toBe(false)
  }, 10_000)

  it('follows again once the user scrolls to the bottom themselves', async () => {
    await openReport()
    await new Promise((r) => setTimeout(r, 800))
    const thread = screen.getByTestId('thread')
    Object.defineProperty(thread, 'scrollTop', { configurable: true, value: 2300 }) // 3000 - 700: the bottom
    fireEvent.scroll(thread)
    scrollTo.mockClear()
    grow()
    await waitFor(() => expect(lastTop()).toBe(3000))
  }, 10_000)
})
