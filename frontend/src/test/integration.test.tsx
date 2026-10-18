// App <-> API flows: fetch and EventSource are stubbed; no network and no demo data.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import mockFindings from './fixtures/findings.json'
import mockReport from './fixtures/report.json'
import mockSpectral from './fixtures/spectral.json'
import { FakeEventSource, detail, offlineFetch, renderApp, routeFetch } from './helpers'
import type { Candidate, ChatResponse, ReportBody, ReportDiff, RuleFindings } from '../types'

const LIVE_CANDIDATE: Candidate = {
  ...(mockFindings.candidates[0] as Candidate),
  key: 's1:NIR:live',
  technique: 'live-only probe',
  technique_id: 'live_only_probe',
}
const liveFindings: RuleFindings = { ...(mockFindings as RuleFindings), candidates: [LIVE_CANDIDATE] }

const liveReport = (runId: string) => ({
  ...mockReport,
  case_id: '',
  title: 'Dairy line fat content',
  run_id: runId,
  sources: [
    { id: 'S01-p10-nir-range', citation: 'S01 p.10', quote: 'NIR covers the stated range.', scope: 'method_general', url: null },
    { id: 'S02-p06-visnir-silica', citation: 'S02 p.6', quote: 'Silica fibers transmit VIS-NIR.', scope: 'lab_study', url: null },
  ],
  findings: liveFindings,
  scope: { label: 'IN_SCOPE', reason: 'measurement enquiry', suggestions: [], tier: 'signals' },
})

const questions = [...(mockReport as ReportBody).clarification_questions].sort((a, b) => a.priority - b.priority)

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
})
afterEach(() => vi.unstubAllGlobals())

const composer = () => screen.getByRole('textbox', { name: /Paste a client enquiry|Ask a follow-up question/ })
const typeAndSend = (text: string) => {
  fireEvent.change(composer(), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}

/** A stored session with one report, as used by several flows. */
const storedRoutes = (extra: Parameters<typeof routeFetch>[0] = {}) =>
  routeFetch({
    '/api/sessions': () => [detail()],
    '/api/kb/spectral': () => mockSpectral,
    '/api/sessions/s9': () => detail(),
    '/api/runs/r7/report': () => liveReport('r7'),
    ...extra,
  })

async function openStored() {
  fireEvent.click(screen.getByRole('button', { name: 'History' }))
  const row = await screen.findByRole('button', { name: /Dairy line fat content/ })
  fireEvent.click(row)
  await screen.findByRole('region', { name: 'Recommendations' })
}

describe('submitting an enquiry', () => {
  it('creates a session from the typed text, starts the run, streams events, then loads the report', async () => {
    let done = false
    const { calls, fetchMock } = routeFetch({
      '/api/sessions': () => [],
      '/api/kb/spectral': () => mockSpectral,
      'POST /api/sessions': () => detail({ messages: [], reports: [] }),
      'POST /api/sessions/s9/runs': () => ({ run_id: 'r9' }),
      '/api/sessions/s9': () => detail(done ? { reports: [{ version: 1, run_id: 'r9' }] } : { reports: [] }),
      '/api/runs/r9/report': () => (done ? liveReport('r9') : { status: 409, body: { detail: 'run is still running' } }),
    })
    renderApp()
    typeAndSend('We want to monitor fat content in milk.')

    // The thread opens at once: bubble with the enquiry, composer docked with the follow-up placeholder.
    expect(await screen.findByText('We want to monitor fat content in milk.')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Ask a follow-up question' })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('heading', { level: 1, name: /Which process/ })).toBeNull())

    await waitFor(() => expect(FakeEventSource.instances.map((e) => e.url)).toContain('/api/runs/r9/events'))
    // the turn API is tried first; a backend without it answers 404 and the enquiry runs as before
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual(['POST /api/sessions', 'POST /api/sessions/s9/turns', 'POST /api/sessions/s9/runs'])
    expect(calls).not.toContain('GET /api/runs/r9/report')
    const create = fetchMock.mock.calls.find(([u, i]) => u === '/api/sessions' && i?.method === 'POST')![1]!
    expect(JSON.parse(create.body as string)).toEqual({ text: 'We want to monitor fat content in milk.' })
    // while it runs the nine stages are listed in the conversation and the report pane shows its live view, not an empty pane
    expect(screen.getByRole('list', { name: 'Pipeline stages' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Run progress' })).toBeInTheDocument()
    expect(screen.queryByRole('tablist')).toBeNull()

    const es = FakeEventSource.for('/api/runs/r9/events')!
    done = true
    act(() => {
      es.emit({ type: 'stage_started', stage: 'scope', seq: 0 })
      es.emit({ type: 'stage_completed', stage: 'scope', seq: 1, payload: { seconds: 0.1 } })
      es.emit({ type: 'run_completed', stage: 'render', seq: 2, payload: { status: 'PROVISIONAL' } })
    })

    expect(await screen.findByRole('region', { name: 'Recommendations' })).toBeInTheDocument()
    // the report is a tabbed workspace beside the conversation: no flowing "Results" thread, no sources cards
    const workspace = within(screen.getByRole('main'))
    expect(workspace.getByRole('tablist', { name: 'Report sections' })).toBeInTheDocument()
    expect(workspace.getByRole('tab', { name: /^Overview/ })).toHaveAttribute('aria-selected', 'true')
    expect(workspace.queryByRole('heading', { name: 'Results' })).toBeNull()
    expect(workspace.queryByRole('region', { name: 'Run progress' })).toBeNull()
    expect(screen.getByText(/Pipeline · 9 stages/)).toBeInTheDocument()
    expect(screen.queryByText('Demo data')).toBeNull()
  })

  it('sends deep and web with the run', async () => {
    routeFetch({
      '/api/sessions': () => [],
      '/api/kb/spectral': () => mockSpectral,
      'POST /api/sessions': () => detail({ messages: [], reports: [] }),
      'POST /api/sessions/s9/runs': () => ({ run_id: 'r9' }),
      '/api/sessions/s9': () => detail({ reports: [] }),
    })
    renderApp()
    fireEvent.click(screen.getByRole('switch', { name: 'Deep' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Web' }))
    typeAndSend('Enquiry text')
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/sessions/s9/runs',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ deep: true, web: true }) }),
      ),
    )
  })

  it('returns to the home composer with the text and a notice when the API cannot be reached', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${String(input)}`)
        if (init?.method === 'POST') throw new TypeError('Failed to fetch')
        return new Response(JSON.stringify([]), { status: 200 })
      }),
    )
    renderApp()
    typeAndSend('Keep this text')
    expect(await screen.findByText(/PRISM's API is not reachable/)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Paste a client enquiry…' })).toHaveValue('Keep this text')
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })
})

describe('a stored session', () => {
  it('feeds the Methods tab from the report findings; the old side panel is gone', async () => {
    storedRoutes()
    renderApp()
    await openStored()
    // the candidate table lives on the Methods tab, not behind a row on the Overview
    expect(screen.queryByRole('table', { name: /Candidate method scores/ })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: /^Methods/ }))
    const table = screen.getByRole('table', { name: /Candidate method scores/ })
    expect(within(table).getByText(/live-only probe/)).toBeInTheDocument()
    expect(screen.queryByText('Demo data')).toBeNull()
    // Breadcrumb and version select stay in the top bar.
    expect(screen.getByRole('button', { name: 'Report version' })).toHaveTextContent('Report v1')
    expect(screen.getByRole('button', { name: 'Assessments' })).toBeInTheDocument()
    // The Lumeo right panel (Sources / Suggested tasks / Suggested questions) is retired.
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(screen.queryByRole('heading', { name: /Suggested (tasks|questions)/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Sources and suggestions' })).toBeNull()
  })

  it('suggested tasks are chips above the composer; questions fill it from the Questions tab; neither sends', async () => {
    const { calls } = storedRoutes()
    renderApp()
    await openStored()
    fireEvent.click(screen.getByRole('tab', { name: /^Questions/ }))
    fireEvent.click(screen.getByRole('button', { name: `Use as follow-up: ${questions[0].question}` }))
    expect(screen.getByRole('textbox', { name: 'Ask a follow-up question' })).toHaveValue(`Client answer to "${questions[0].question}": `)

    const tasks = screen.getByRole('group', { name: 'Suggested tasks' })
    fireEvent.click(within(tasks).getByRole('button', { name: 'Explain the decision status' }))
    expect(screen.getByRole('textbox', { name: 'Ask a follow-up question' })).toHaveValue('Explain the decision status of this assessment.')
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual([])
  })

  it('a source on the Evidence tab opens its viewer inside the report pane', async () => {
    storedRoutes({ '/api/kb/cards/S01-p10-nir-range': () => ({ id: 'x' }) })
    renderApp()
    await openStored()
    fireEvent.click(screen.getByRole('tab', { name: /^Evidence/ }))
    const pane = screen.getByRole('region', { name: 'Assessment report' })
    fireEvent.click(within(pane).getByRole('button', { name: /NIR range/ }))
    expect(await within(pane).findByRole('article', { name: /^Evidence / })).toBeInTheDocument()
    expect(within(pane).getByRole('button', { name: 'Close evidence' })).toBeInTheDocument()
  })

  it('a 422 refused report shows the refusal with suggestions that fill the composer', async () => {
    routeFetch({
      '/api/sessions': () => [detail({ id: 's5', title: 'Weather question' })],
      '/api/sessions/s5': () =>
        detail({
          id: 's5',
          title: 'Weather question',
          reports: [],
          messages: [
            { id: 'm1', session_id: 's5', role: 'user', kind: 'enquiry', text: 'What is the weather?', run_id: 'r5', created_at: '2026-10-17T09:00:00Z' },
            { id: 'm2', session_id: 's5', role: 'assistant', kind: 'refused', text: 'Refused.', run_id: 'r5', created_at: '2026-10-17T09:01:00Z' },
          ],
        }),
      '/api/runs/r5/report': () => ({
        status: 422,
        body: {
          refused: true,
          scope: { label: 'OFF_TOPIC', reason: 'The enquiry is not about a measurement task.', suggestions: ['Can a probe measure moisture in powder?'], tier: 'signals' },
          markdown: '# Refused',
        },
      }),
    })
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'History' }))
    fireEvent.click(await screen.findByRole('button', { name: /Weather question/ }))
    expect(await screen.findByText('The enquiry is not about a measurement task.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Outside PRISM's scope/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Can a probe measure moisture in powder?' }))
    expect(screen.getByRole('textbox', { name: 'Ask a follow-up question' })).toHaveValue('Can a probe measure moisture in powder?')
  })

  it('lists report versions and opens the diff from "Compare with previous"', async () => {
    const diff: ReportDiff = {
      status: { from: 'INSUFFICIENT_INFORMATION', to: 'PROVISIONAL' },
      verdict: null,
      recommendations: { added: [], removed: [], changed: [] },
      questions: { resolved: ['Distance to the analyzer?'], new: [] },
      risks: { added: [], removed: [] },
    }
    storedRoutes({
      '/api/sessions/s9': () => detail({ reports: [{ version: 1, run_id: 'r6' }, { version: 2, run_id: 'r7' }] }),
      '/api/runs/r6/report': () => liveReport('r6'),
      '/api/sessions/s9/diff?from=1&to=2': () => diff,
    })
    renderApp()
    await openStored()
    const select = screen.getByRole('button', { name: 'Report version' })
    expect(select).toHaveTextContent('Report v2')
    fireEvent.click(select)
    const menu = screen.getByRole('menu', { name: 'Report version' })
    expect(within(menu).getAllByRole('menuitemradio').map((i) => i.textContent)).toEqual(['Report v2', 'Report v1'])
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Compare with previous' }))
    const dialog = await screen.findByRole('dialog', { name: 'Report v1 → v2' })
    expect(await within(dialog).findByText('Distance to the analyzer?')).toBeInTheDocument()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Report v1 → v2' })).toBeNull()

    // choosing an older version shows that run's report
    fireEvent.click(screen.getByRole('button', { name: 'Report version' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Report v1' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Report version' })).toHaveTextContent('Report v1'))
  })

  it('the mode select switches between Standard and Deep', async () => {
    routeFetch({ '/api/sessions': () => [] })
    renderApp()
    const mode = screen.getByRole('button', { name: 'Reasoning mode' })
    expect(mode).toHaveTextContent('Standard')
    fireEvent.click(mode)
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Deep' }))
    expect(screen.getByRole('button', { name: 'Reasoning mode' })).toHaveTextContent('Deep')
    expect(screen.getByRole('switch', { name: 'Deep' })).toHaveAttribute('aria-checked', 'true')
  })
})

describe('follow-ups in the thread', () => {
  it('posts the message, shows the answer inline with citations and suggestion chips', async () => {
    const answer: ChatResponse = {
      kind: 'answer',
      text: 'The silica fiber does not transmit the MIR range.',
      cited_ids: ['S02-p06-visnir-silica'],
      tool_calls: [{ name: 'check_fiber_window' }],
      proposed_facts: [],
    }
    const { calls, fetchMock } = storedRoutes({ 'POST /api/sessions/s9/messages': () => answer })
    renderApp()
    await openStored()

    typeAndSend('Can MIR run over the fiber?')
    // a fresh answer reveals word by word, so its text is split across spans
    expect(await screen.findByText((_, el) => el?.tagName === 'P' && el.textContent === answer.text)).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions/s9/messages',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'Can MIR run over the fiber?' }) }),
    )
    expect(screen.getByText('Can MIR run over the fiber?')).toBeInTheDocument()
    expect(screen.getByText('check_fiber_window')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Ask a follow-up question' })).toHaveValue('')

    // chips under the answer fill the composer and never send
    const chips = screen.getAllByRole('group', { name: 'Suggestions' })[0]
    const first = within(chips).getAllByRole('button')[0]
    fireEvent.click(first)
    expect(screen.getByRole('textbox', { name: 'Ask a follow-up question' })).toHaveValue(first.textContent)
    expect(calls.filter((c) => c === 'POST /api/sessions/s9/messages')).toHaveLength(1)
  })

  it('a new-run response streams the run below and then shows the diff', async () => {
    const diff: ReportDiff = {
      status: { from: 'INSUFFICIENT_INFORMATION', to: 'PROVISIONAL' },
      verdict: null,
      recommendations: { added: [], removed: [], changed: [] },
      questions: { resolved: ['Distance to the analyzer?'], new: [] },
      risks: { added: [], removed: [] },
    }
    let stored = false
    storedRoutes({
      '/api/sessions/s9': () => detail(stored ? { reports: [{ version: 1, run_id: 'r7' }, { version: 2, run_id: 'r8' }] } : {}),
      'POST /api/sessions/s9/messages': () => ({ kind: 'run', run_id: 'r8' }),
      '/api/sessions/s9/diff?from=1&to=2': () => diff,
      '/api/runs/r8/report': () => (stored ? liveReport('r8') : { status: 409, body: { detail: 'run is still running' } }),
    })
    renderApp()
    await openStored()

    typeAndSend('The analyzer stands next to the line.')
    expect(await screen.findByText('New version v2 running…')).toBeInTheDocument()
    const es = FakeEventSource.for('/api/runs/r8/events')!
    expect(es).toBeDefined()
    stored = true
    act(() => {
      es.emit({ type: 'stage_started', stage: 'scope', seq: 0 }, 'r8')
      es.emit({ type: 'run_completed', seq: 1, payload: { status: 'PROVISIONAL' } }, 'r8')
    })
    const region = await screen.findByRole('region', { name: 'Changes from v1 to v2' })
    expect(within(region).getByText('Distance to the analyzer?')).toBeInTheDocument()

    // the new version waits in the conversation as a notice; the report pane keeps showing v1 until it is opened
    const notice = screen.getByRole('region', { name: 'Report v2' })
    expect(within(notice).getByText('Report v2 ready')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Report version' })).toHaveTextContent('Report v1')
    fireEvent.click(within(notice).getByRole('button', { name: 'Open report v2' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Report version' })).toHaveTextContent('Report v2'))
    expect(await screen.findByRole('region', { name: 'Recommendations' })).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Report v2' })).getByText('Showing')).toBeInTheDocument()
  })

  it('a refused message shows the reason; its suggestions fill the composer', async () => {
    storedRoutes({
      'POST /api/sessions/s9/messages': () => ({
        kind: 'refused',
        reason: 'This is not about in-line spectroscopy.',
        suggestions: ['Ask about the fiber link for the recommended method.'],
      }),
    })
    renderApp()
    await openStored()
    typeAndSend('Tell me a joke')
    expect(await screen.findByText('This is not about in-line spectroscopy.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Ask about the fiber link for the recommended method.' }))
    expect(screen.getByRole('textbox', { name: 'Ask a follow-up question' })).toHaveValue('Ask about the fiber link for the recommended method.')
  })
})

describe('offline', () => {
  it('has no mock report, no demo badge and no case list', async () => {
    offlineFetch()
    renderApp()
    expect(await screen.findByText(/PRISM's API is not reachable/)).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Recommendations' })).toBeNull()
    expect(screen.queryByText('Demo data')).toBeNull()
    expect(screen.queryByText(/D01|Replay mock/)).toBeNull()
  })
})
