import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { CommandPalette } from '../components/CommandPalette'
import { EvidenceViewer } from '../components/EvidenceViewer'
import { PlanTimeline } from '../components/report/PlanTimeline'
import { ReportHelp } from '../components/report/ReportHelp'
import { SectionSkeleton } from '../components/workspace/TabSection'
import { completeReport } from '../reportData'
import { detail, renderApp, routeFetch } from './helpers'
import fixture from './fixtures/report.json'
import spectral from './fixtures/spectral.json'

vi.mock('plotly.js-dist-min', () => ({ default: {} }))
vi.mock('react-plotly.js/factory', () => ({ default: () => () => <div data-testid="plot" /> }))
const emptyPlan = completeReport({}).feasibility_plan

describe('report reading help', () => {
  it('explains statuses, claims, sources, versions and check limits; Escape restores focus', () => {
    render(<ReportHelp />)
    const trigger = screen.getByRole('button', { name: 'How to read this report' })
    trigger.focus()
    fireEvent.click(trigger)
    const help = screen.getByRole('dialog', { name: 'How to read this report' })
    for (const label of ['Provisional', 'Insufficient information', 'Outside supported scope', 'Claims and citations', 'Versions', 'Checks']) {
      expect(within(help).getByText(label)).toBeInTheDocument()
    }
    expect(help).toHaveTextContent('Assumption')
    expect(help).toHaveTextContent('Unknown')
    expect(help).toHaveTextContent('What changed')
    expect(help).toHaveTextContent('does not establish scientific correctness')
    expect(within(help).getByRole('button', { name: 'Close report help' })).toHaveFocus()
    fireEvent.keyDown(help, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger).toHaveFocus()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('shortcut discovery', () => {
  it('offers search recovery and keyboard help; traps focus and closes with Escape from help', () => {
    const close = vi.fn()
    render(<CommandPalette open commands={[]} onClose={close} />)
    const input = screen.getByRole('combobox', { name: 'Command' })
    expect(input).toHaveFocus()
    expect(screen.getByText(/Try an assessment title or fewer search words/)).toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: 'Keyboard shortcuts' })
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })
    expect(toggle).toHaveFocus()
    fireEvent.click(toggle)
    const help = screen.getByText('Open search and commands').closest('dl')!
    for (const key of ['Ctrl K', '⌘K', '1–8', 'Shift Enter']) expect(help).toHaveTextContent(key)
    fireEvent.keyDown(toggle, { key: 'Escape' })
    expect(close).toHaveBeenCalledOnce()
  })
})

describe('meaningful empty report states', () => {
  it('shows one actionable empty plan while preserving populated scientific details and citations', () => {
    const { rerender } = render(<PlanTimeline plan={emptyPlan} />)
    expect(screen.getByText(/Ask in Conversation for a study plan/)).toBeInTheDocument()
    expect(screen.queryByText('Not specified.')).toBeNull()
    expect(screen.queryByText('Samples and states')).toBeNull()
    const cite = vi.fn()
    rerender(<PlanTimeline plan={{ ...emptyPlan, steps: ['Compare with independent references.'], validation: [{ text: 'Use independent validation samples.', claim_type: 'PROPOSAL', evidence_ids: ['S01-card'] }] }} onCite={cite} citations={{ 'S01-card': 'S01 p.10' }} />)
    expect(screen.getByText('Use independent validation samples.')).toBeInTheDocument()
    expect(screen.getByText('Criteria to be agreed with client')).toBeInTheDocument()
    expect(screen.queryByText('Not demonstrated')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show source S01 p.10' }))
    expect(cite).toHaveBeenCalledWith('S01-card')
  })

  it('explains loading rather than showing anonymous skeletons', () => {
    render(<SectionSkeleton label="Measurement concept" />)
    expect(screen.getByRole('status', { name: 'Loading measurement concept' })).toHaveTextContent('You can continue reading the other report tabs while you wait.')
  })

  it('gives next steps on empty tabs without treating zero questions or checks as success', async () => {
    history.replaceState(null, '', '/a/s9')
    routeFetch({
      '/api/sessions': () => [detail()], '/api/sessions/s9': () => detail(), '/api/kb/spectral': () => spectral,
      '/api/runs/r7/report': () => ({ ...fixture, run_id: 'r7', direct_answer: { verdict: 'NOT_YET', text: [] }, recommendations: [], spectral_ranges: [], measurement_concept: [], feasibility_plan: emptyPlan, clarification_questions: [], sources: [], compliance: {}, findings: { findings: [], candidates: [] } }),
    })
    renderApp()
    await screen.findByRole('tablist', { name: 'Report sections' })
    expect(screen.getByText(/No direct answer was recorded/)).toBeInTheDocument()
    for (const [tab, message] of [
      ['Methods', /Add the target measurement and process conditions/], ['Spectral', /Ask in Conversation for cited spectral ranges/],
      ['Concept', /Add the measurement location, optical state/], ['Plan', /Ask in Conversation for a study plan/],
      ['Questions', /Review the key unknowns in Concept/], ['Evidence', /Ask in Conversation for the evidence/],
      ['Checks', /request a new assessment in Conversation/],
    ] as const) {
      fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${tab}`) }))
      expect(await within(screen.getByRole('tabpanel')).findByText(message)).toBeInTheDocument()
    }
    expect(screen.queryByText('0/0 passed')).toBeNull()
    expect(screen.queryByText(/nothing open blocks/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'How to read this report' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close report help' }), { key: '1' })
    expect(screen.getByRole('tab', { name: /^Checks/ })).toHaveAttribute('aria-selected', 'true')
  })
})

it('retries a missing evidence source from its recovery action', async () => {
  let fail = true
  const { calls } = routeFetch({ '/api/kb/cards/S01-card': () => fail ? { status: 503, body: { detail: 'Unavailable' } } : { id: 'S01-card', source_id: 'S01', citation: 'S01 p.10', quote: 'Recovered source passage.', scope: 'method_general' } })
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><EvidenceViewer cardId="S01-card" /></QueryClientProvider>)
  const retry = await screen.findByRole('button', { name: 'Retry source' })
  fail = false
  await act(async () => { fireEvent.click(retry) })
  expect(await screen.findByText('Recovered source passage.')).toBeInTheDocument()
  await waitFor(() => expect(calls.filter((call) => call === 'GET /api/kb/cards/S01-card')).toHaveLength(2))
})
