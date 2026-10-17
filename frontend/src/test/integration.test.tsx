// App ↔ API integration flows (Task 30b): fetch and EventSource are stubbed; no network.
import { QueryClient } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import mockFindings from '../mock/findings.json'
import mockReport from '../mock/report.json'
import mockSpectral from '../mock/spectral.json'
import type { CaseInfo, Candidate, RunEvent, RuleFindings, SessionDetail } from '../types'

// ---------------------------------------------------------------- helpers

type Reply = { status?: number; body: unknown }
type Handler = (init?: RequestInit) => Reply | unknown

/** Stub `fetch` with a "METHOD url" → handler map; unknown routes answer 404. */
function routeFetch(routes: Record<string, Handler>) {
  const calls: string[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`
    calls.push(key)
    const handler = routes[key]
    if (!handler) return new Response(JSON.stringify({ detail: 'not found' }), { status: 404 })
    const out = handler(init)
    const reply: Reply =
      out && typeof out === 'object' && 'body' in out && 'status' in out ? (out as Reply) : { body: out }
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, calls }
}

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly url: string
  readyState = 0
  onopen: ((e: Event) => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }
  addEventListener() {}
  removeEventListener() {}
  close() {
    this.readyState = 2
  }
  emit(event: Partial<RunEvent> & Pick<RunEvent, 'type' | 'seq'>) {
    const full: RunEvent = { run_id: 'r9', ts: 1_760_000_000.5, stage: null, payload: {}, ...event }
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(full) }))
  }
}

const renderApp = () =>
  render(<App queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />)

const cases: CaseInfo[] = [
  { case_id: 'D01', title: 'Dev case one', kind: 'dev' },
  { case_id: 'H01', title: 'Eval case one', kind: 'eval' },
]

const LIVE_CANDIDATE: Candidate = {
  ...(mockFindings.candidates[0] as Candidate),
  key: 's1:NIR:live',
  technique: 'live-only probe',
  technique_id: 'live_only_probe',
}
const liveFindings: RuleFindings = { ...(mockFindings as RuleFindings), candidates: [LIVE_CANDIDATE] }

const liveReport = (runId: string) => ({
  ...mockReport,
  case_id: 'D01',
  title: 'Dev case one',
  run_id: runId,
  findings: liveFindings,
  scope: { label: 'IN_SCOPE', reason: 'measurement enquiry', suggestions: [], tier: 'signals' },
})

const detail = (over: Partial<SessionDetail> = {}): SessionDetail => ({
  id: 's9',
  title: 'D01 · Dev case one',
  case_id: 'D01',
  created_at: '2026-10-17T09:00:00Z',
  messages: [],
  reports: [],
  ...over,
})

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
})
afterEach(() => vi.unstubAllGlobals())

// ---------------------------------------------------------------- flows

describe('App against the live API', () => {
  it('case click creates a session, starts a run, streams events, then loads the report', async () => {
    let done = false
    const { calls } = routeFetch({
      'GET /api/sessions': () => [],
      'GET /api/cases': () => cases,
      'GET /api/kb/spectral': () => mockSpectral,
      'POST /api/sessions': () => detail(),
      'POST /api/sessions/s9/runs': () => ({ run_id: 'r9' }),
      'GET /api/sessions/s9': () => detail(done ? { reports: [{ version: 1, run_id: 'r9' }] } : {}),
      'GET /api/runs/r9/report': () =>
        done ? liveReport('r9') : { status: 409, body: { detail: 'run is still running' } },
    })
    renderApp()

    const dev = await screen.findByRole('region', { name: 'Dev' })
    fireEvent.click(await within(dev).findByRole('button', { name: /D01/ }))

    await waitFor(() => expect(FakeEventSource.instances.map((e) => e.url)).toContain('/api/runs/r9/events'))
    const posts = calls.filter((c) => c.startsWith('POST'))
    expect(posts).toEqual(['POST /api/sessions', 'POST /api/sessions/s9/runs'])
    // The report is not requested before the run has finished.
    expect(calls).not.toContain('GET /api/runs/r9/report')

    const es = FakeEventSource.instances.find((e) => e.url === '/api/runs/r9/events')!
    done = true
    act(() => {
      es.emit({ type: 'stage_started', stage: 'scope', seq: 0 })
      es.emit({ type: 'stage_completed', stage: 'scope', seq: 1, payload: { seconds: 0.1 } })
      es.emit({ type: 'run_completed', stage: 'render', seq: 2, payload: { status: 'PROVISIONAL' } })
    })

    expect(await screen.findByRole('tab', { name: 'Methods' })).toBeInTheDocument()
    expect(calls).toContain('GET /api/runs/r9/report')
    const order = ['POST /api/sessions', 'POST /api/sessions/s9/runs', 'GET /api/runs/r9/report'].map((c) =>
      calls.indexOf(c),
    )
    expect(order).toEqual([...order].sort((a, b) => a - b))
    const body = (vi.mocked(fetch).mock.calls.find(([u, i]) => u === '/api/sessions' && i?.method === 'POST')![1]!
      .body as string)
    expect(JSON.parse(body)).toEqual({ case_id: 'D01' })
    expect(screen.queryByText('Demo data')).toBeNull()
  })

  it('a report with findings feeds the heatmap without mocks', async () => {
    routeFetch({
      'GET /api/sessions': () => [detail()],
      'GET /api/cases': () => cases,
      'GET /api/kb/spectral': () => mockSpectral,
      'GET /api/sessions/s9': () => detail({ reports: [{ version: 1, run_id: 'r7' }] }),
      'GET /api/runs/r7/report': () => liveReport('r7'),
    })
    renderApp()

    const mine = await screen.findByRole('region', { name: 'Mine' })
    fireEvent.click(await within(mine).findByRole('button', { name: /Dev case one/ }))
    fireEvent.click(await screen.findByRole('tab', { name: 'Methods' }))
    const table = screen.getByRole('table', { name: /Candidate method scores/ })
    expect(within(table).getByText(/live-only probe/)).toBeInTheDocument()
    expect(within(table).queryByText(/transmission or transflection probe/)).toBeNull()
    expect(screen.queryByText('Demo data')).toBeNull()
  })

  it('a 422 refused report shows the RefusalCard', async () => {
    routeFetch({
      'GET /api/sessions': () => [detail({ id: 's5', title: 'Weather question', case_id: null })],
      'GET /api/cases': () => cases,
      'GET /api/kb/spectral': () => mockSpectral,
      'GET /api/sessions/s5': () =>
        detail({
          id: 's5',
          case_id: null,
          messages: [
            {
              id: 'm2',
              session_id: 's5',
              role: 'assistant',
              kind: 'refused',
              text: 'Refused.',
              run_id: 'r5',
              created_at: '2026-10-17T09:01:00Z',
            },
          ],
        }),
      'GET /api/runs/r5/report': () => ({
        status: 422,
        body: {
          refused: true,
          scope: {
            label: 'OFF_TOPIC',
            reason: 'The enquiry is not about a measurement task.',
            suggestions: ['Can a probe measure moisture in powder?'],
            tier: 'signals',
          },
          markdown: '# Refused',
        },
      }),
    })
    renderApp()

    const mine = await screen.findByRole('region', { name: 'Mine' })
    fireEvent.click(await within(mine).findByRole('button', { name: /Weather question/ }))
    const card = await screen.findByText('The enquiry is not about a measurement task.')
    expect(card).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Can a probe measure moisture in powder?' })).toBeInTheDocument()
  })

  it('the deep reasoning toggle is sent when a run starts', async () => {
    routeFetch({
      'GET /api/sessions': () => [],
      'GET /api/cases': () => cases,
      'GET /api/kb/spectral': () => mockSpectral,
      'POST /api/sessions': () => detail(),
      'POST /api/sessions/s9/runs': () => ({ run_id: 'r9' }),
      'GET /api/sessions/s9': () => detail(),
    })
    renderApp()

    const toggle = screen.getByRole('switch', { name: 'Deep reasoning' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(toggle).toHaveAttribute('title', 'slower, used for the official answers')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    const dev = await screen.findByRole('region', { name: 'Dev' })
    fireEvent.click(await within(dev).findByRole('button', { name: /D01/ }))
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/sessions/s9/runs',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ deep: true }) }),
      ),
    )
  })

  it('shows the Demo data badge with mocks when the backend is offline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    renderApp()
    expect((await screen.findAllByText('Demo data')).length).toBeGreaterThan(0)
    expect(await screen.findByRole('tab', { name: 'Methods' })).toBeInTheDocument()
  })

  it('shows no mock report while the backend is online and nothing is selected', async () => {
    routeFetch({ 'GET /api/sessions': () => [], 'GET /api/cases': () => cases, 'GET /api/kb/spectral': () => mockSpectral })
    renderApp()
    await screen.findByRole('region', { name: 'Dev' })
    await waitFor(() => expect(screen.getByText(/Pick a case/)).toBeInTheDocument())
    expect(screen.queryByRole('tab', { name: 'Methods' })).toBeNull()
    expect(screen.queryByText('Demo data')).toBeNull()
  })
})
