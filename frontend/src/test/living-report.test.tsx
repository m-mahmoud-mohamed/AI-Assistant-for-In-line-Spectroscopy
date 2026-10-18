import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadJson, downloadMarkdown, downloadPdf, reportToMarkdown } from '../export'
import { DiffView } from '../components/DiffView'
import { ReportPrintDocument } from '../components/report/ReportPrintDocument'
import { TabSection } from '../components/workspace/TabSection'
import { completeReport, type RawReport } from '../reportData'
import type { ReportDiff } from '../types'
import fixture from './fixtures/report.json'
import mockFindings from './fixtures/findings.json'
import mockSpectral from './fixtures/spectral.json'
import { FakeEventSource, detail, renderApp, routeFetch } from './helpers'

vi.mock('plotly.js-dist-min', () => ({ default: {} }))
vi.mock('react-plotly.js/factory', () => ({ default: () => () => <div data-testid="plot" /> }))

const raw = {
  ...fixture,
  original_enquiry: 'Full original client enquiry, including constraints.',
  sources: [{ id: 'S01-p10-nir-range', citation: 'S01 p.10', quote: 'NIR spectra (780–2500 nm)', scope: 'method_general', url: null }],
  version_info: { session_id: 'session-1', version: 2, trigger: '240 samples are available.', summary: 'Updated the feasibility plan.', changed_sections: ['plan'], follow_up_findings: ['240 samples are available.'] },
} as unknown as RawReport
const report = completeReport(raw)

const blob = vi.fn()
beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn((b: Blob) => { blob(b); return 'blob:test' }), revokeObjectURL: vi.fn() }))
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  blob.mockClear()
})

describe('local Markdown export', () => {
  it('has the enquiry, version, numbered references and the version change, and no UI strings', () => {
    const md = reportToMarkdown(report)
    expect(md).toContain('> Full original client enquiry, including constraints.')
    expect(md).toContain('Report v2')
    expect(md).toContain('Changes in this version')
    expect(md).toContain('Updated the feasibility plan.')
    expect(md).toContain('Reference measurements')
    expect(md).toContain('1. S01 p.10: “NIR spectra (780–2500 nm)”')
    for (const ui of ['Use as follow-up', 'more in Methods', 'Method detail', 'hover']) expect(md).not.toContain(ui)
  })
})

describe('server exports of the version on screen', () => {
  it('the Markdown, JSON and PDF are fetched for the run on screen with the appendix choices', async () => {
    const { fetchMock } = routeFetch({
      '/api/runs/r7/report.md?appendix=conversation': () => 'x',
      '/api/runs/r7/report.json?appendix=technical': () => ({ ok: true }),
      '/api/runs/r7/report.pdf': () => ({ pdf: true }),
    })
    vi.spyOn(globalThis, 'fetch')
    await downloadMarkdown(report, 'r7', { includeConversation: true })
    await downloadJson(report, 'r7', { includeTechnical: true })
    expect(await downloadPdf(report, 'r7')).toBe(true)
    expect(blob).toHaveBeenCalledTimes(3)
    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(urls).toEqual(['/api/runs/r7/report.md?appendix=conversation', '/api/runs/r7/report.json?appendix=technical', '/api/runs/r7/report.pdf'])
  })

  it('without a server the PDF is not available (the caller prints), Markdown falls back to the local rendering', async () => {
    routeFetch({})
    expect(await downloadPdf(report, 'r7')).toBe(false)
    expect(await downloadPdf(report, null)).toBe(false)
    await downloadMarkdown(report, 'r7')
    expect(blob).toHaveBeenCalledTimes(1)
    expect(await (blob.mock.calls[0][0] as Blob).text()).toContain('Full original client enquiry')
  })
})

describe('print document', () => {
  it('renders the server document blocks: tables with column widths, quotes, lists, the chart as an image', () => {
    const b = { text: '', items: [], columns: [], rows: [], widths: [], level: 2, svg: '', title: '' }
    render(
      <ReportPrintDocument
        report={report}
        doc={{
          title: 'A whole title', version: 2, date: '18 October 2026', status: 'Provisional assessment', prepared_by: 'PRISM',
          front: [{ ...b, kind: 'quote', text: 'Full enquiry' }],
          sections: [{ id: 'ranges', title: 'Spectral ranges', blocks: [
            { ...b, kind: 'figure', svg: '<svg xmlns="http://www.w3.org/2000/svg"/>', title: 'Windows' },
            { ...b, kind: 'table', columns: ['Method', 'Range'], rows: [['NIR', '**780–2500 nm**']], widths: [30, 70] },
            { ...b, kind: 'ol', items: ['one', 'two'] },
          ] }],
          legend: ['† external (web) source'],
        }}
      />,
    )
    expect(screen.getByRole('heading', { level: 1, name: 'A whole title' })).toBeInTheDocument()
    expect(screen.getByText(/Report v2/)).toBeInTheDocument()
    expect(screen.getByText('Full enquiry')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: '1 Spectral ranges' })).toBeInTheDocument()
    expect(screen.getByRole('table')).toHaveTextContent('780–2500 nm')
    expect(screen.getByAltText('Windows')).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText(/Markers: †/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('until the document arrives the title, enquiry and answer print from the report on screen', () => {
    render(<ReportPrintDocument report={report} />)
    expect(screen.getByText('Full original client enquiry, including constraints.')).toBeInTheDocument()
    expect(screen.getByText(/Report v2/)).toBeInTheDocument()
  })
})

describe('copy', () => {
  it('copies a section with its tables as Markdown tables and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<TabSection title="Ranges"><table><thead><tr><th>Method</th><th>Range</th></tr></thead><tbody><tr><td>NIR</td><td>780–2500 nm</td></tr></tbody></table></TabSection>)
    fireEvent.click(screen.getByRole('button', { name: 'Copy Ranges' }))
    expect(await screen.findByText('Copied')).toBeInTheDocument()
    expect(writeText.mock.calls[0][0]).toContain('| Method | Range |\n| --- | --- |\n| NIR | 780–2500 nm |')
  })
})

describe('What changed', () => {
  it('lists the lines added and removed per changed report section', () => {
    const diff: ReportDiff = {
      status: null, verdict: null, recommendations: { added: [], removed: [], changed: [] },
      questions: { resolved: [], new: [] }, risks: { added: [], removed: [] },
      sections: [{ field: 'feasibility_plan', label: 'Feasibility plan', section: 'plan', added: ['Use 240 physical samples.'], removed: ['Collect samples.'] }],
    }
    render(<DiffView diff={diff} from={1} to={2} />)
    const group = screen.getByText('Feasibility plan').closest('details')!
    expect(group).toHaveTextContent('1 added, 1 removed')
    expect(within(group).getByText('Use 240 physical samples.')).toBeInTheDocument()
    expect(within(group).getByText('Collect samples.')).toHaveTextContent('Collect samples.')
    expect(screen.queryByText('No changes between the two versions.')).toBeNull()
  })
})

describe('the living report in the app', () => {
  const richReport = (runId: string, v: number) => ({
    ...fixture, run_id: runId, title: 'Dairy line fat content', case_id: '', created_at: '2026-10-17T09:00:00Z', findings: mockFindings,
    scope: { label: 'IN_SCOPE', reason: 'ok', suggestions: [], tier: 'signals' }, original_enquiry: 'We want to monitor fat content in milk.',
    version_info: v === 1
      ? { session_id: 's9', version: 1, trigger: '', changed_sections: [], summary: 'Initial assessment.', follow_up_findings: [] }
      : { session_id: 's9', version: 2, trigger: 'We have 240 physical samples.', changed_sections: ['plan', 'requirements'], summary: 'Updated questions, feasibility plan and decision basis.', follow_up_findings: ['We have 240 physical samples.'] },
  })
  const diff: ReportDiff = {
    status: null, verdict: null, recommendations: { added: [], removed: [], changed: [] }, questions: { resolved: [], new: [] },
    risks: { added: [], removed: [] },
    sections: [{ field: 'feasibility_plan', label: 'Feasibility plan', section: 'plan', added: ['Use 240 physical samples.'], removed: [] }],
  }

  it('shows the latest version with what triggered it, marks updated tabs, lets the user switch back and see what changed', async () => {
    routeFetch({
      '/api/sessions': () => [detail()],
      '/api/kb/spectral': () => mockSpectral,
      '/api/sessions/s9': () => detail({ reports: [{ version: 1, run_id: 'r6' }, { version: 2, run_id: 'r7', trigger: 'We have 240 physical samples.' }] }),
      '/api/runs/r6/report': () => richReport('r6', 1),
      '/api/runs/r7/report': () => richReport('r7', 2),
      '/api/sessions/s9/diff?from=1&to=2': () => diff,
    })
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Assessments' }))
    fireEvent.click(await screen.findByRole('button', { name: /Dairy line fat content/ }))
    await screen.findByRole('tablist', { name: 'Report sections' })
    const pane = screen.getByRole('region', { name: 'Assessment report' })
    // v2 is on show: its trigger and summary under the title, the updated tabs marked
    expect(await within(pane).findByText(/after “We have 240 physical samples.”/)).toHaveTextContent('Updated questions, feasibility plan and decision basis.')
    expect(within(pane).getByText(/Report v2 · /)).toBeInTheDocument()
    expect(within(pane).getByRole('tab', { name: /^Plan/ }).querySelector('.tab-updated')).not.toBeNull()
    expect(within(pane).getByRole('tab', { name: /^Methods/ }).querySelector('.tab-updated')).toBeNull()
    // "What changed" opens the comparison with the previous version
    fireEvent.click(within(pane).getAllByRole('button', { name: 'What changed' })[0])
    const dialog = await screen.findByRole('dialog', { name: 'Report v1 → v2' })
    expect(await within(dialog).findByText('Use 240 physical samples.')).toBeInTheDocument()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    // the version selector goes back to v1: no change banner there
    fireEvent.click(within(pane).getByRole('button', { name: 'Switch report version' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Report v1' }))
    await waitFor(() => expect(screen.getByRole('region', { name: 'Assessment report' }).querySelector('.rh-meta')?.textContent).toMatch(/Report v1/))
    expect(within(screen.getByRole('region', { name: 'Assessment report' })).queryByText(/after “We have/)).toBeNull()
  })

  it('an assistant turn that writes a new version attaches the report pane to it', async () => {
    const detailBefore = detail({ reports: [{ version: 1, run_id: 'r6' }] })
    let done = false
    routeFetch({
      '/api/sessions': () => [detail()],
      '/api/kb/spectral': () => mockSpectral,
      '/api/sessions/s9': () => (done ? detail({ reports: [{ version: 1, run_id: 'r6' }, { version: 2, run_id: 'r8', trigger: 'We have 240 physical samples.' }] }) : detailBefore),
      '/api/runs/r6/report': () => richReport('r6', 1),
      '/api/runs/r8/report': () => (done ? richReport('r8', 2) : { status: 409, body: { detail: 'run is still running' } }),
      'POST /api/sessions/s9/turns': () => ({ turn_id: 't1' }),
    })
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Assessments' }))
    fireEvent.click(await screen.findByRole('button', { name: /Dairy line fat content/ }))
    await screen.findByRole('tablist', { name: 'Report sections' })
    const box = screen.getByRole('textbox', { name: /Ask a follow-up question/ })
    fireEvent.change(box, { target: { value: 'We have 240 physical samples.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const turn = await waitFor(() => {
      const t = FakeEventSource.for('/api/turns/t1/events')
      expect(t).toBeDefined()
      return t!
    })
    done = true
    act(() => turn.emitRaw({ type: 'report', turn_id: 't1', seq: 0, ts: 1, payload: { run_id: 'r8', version: 2 } }))
    const stream = await waitFor(() => {
      const r = FakeEventSource.for('/api/runs/r8/events')
      expect(r).toBeDefined()
      return r!
    })
    act(() => stream.emit({ type: 'run_completed', seq: 0, stage: 'render', payload: { status: 'PROVISIONAL' } }, 'r8'))
    await screen.findByRole('tablist', { name: 'Report sections' })
    const pane = screen.getByRole('region', { name: 'Assessment report' })
    expect(await within(pane).findByText(/after “We have 240 physical samples.”/)).toBeInTheDocument()
  })
})
