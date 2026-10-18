// The assistant inside the app: a turn streams into the conversation column (plan, tool rows, question card, verdict),
// answers and approvals reach the API, Stop interrupts, the report pane attaches to the run the turn starts and fills
// from `engine_ready` and `section_ready`, and a backend without the turn API (404) keeps the old behaviour.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyEvents, initialPipelineState } from '../pipeline/reducer'
import { stagesRun } from '../pipeline/status'
import mockFindings from './fixtures/findings.json'
import mockReport from './fixtures/report.json'
import mockSpectral from './fixtures/spectral.json'
import { FakeEventSource, detail, renderApp, routeFetch } from './helpers'
import type { ClarifyQuestion, EnginePreview, RunEvent, RunEventType, SessionDetail, Stage } from '../types'

const optics: ClarifyQuestion = {
  id: 'optics',
  slot: 'streams.s1.optics',
  stream_id: 's1',
  text: 'What does the product look like optically?',
  why: 'It decides the probe geometry.',
  impact: 'PRIMARY_METHOD_CHANGE',
  options: [
    { value: 'clear', label: 'Clear liquid', effect: 'transmission probe' },
    { value: 'turbid', label: 'Turbid or opaque', effect: 'diffuse reflection probe' },
  ],
}
const preview: EnginePreview = {
  status: 'INSUFFICIENT_INFORMATION',
  candidates: [
    { method: 'NIR', technique: 'transmission or transflection probe', score: 5, blocked: false },
    { method: 'Raman', technique: 'Raman probe', score: 4, blocked: false },
    { method: 'MIR', technique: 'ATR probe', score: 2, blocked: true },
  ],
  questions: [optics],
  spectral_methods: ['NIR', 'Raman'],
}

const liveReport = (runId: string) => ({
  ...mockReport,
  case_id: '',
  title: 'Dairy line fat content',
  run_id: runId,
  sources: [{ id: 'S01-p10-nir-range', citation: 'S01 p.10', quote: 'NIR covers the stated range.', scope: 'method_general', url: null }],
  findings: mockFindings,
  scope: { label: 'IN_SCOPE', reason: 'measurement enquiry', suggestions: [], tier: 'signals' },
})

/** A session whose enquiry has no run yet (the assistant starts the assessment). */
const newSession = (over: Partial<SessionDetail> = {}) => {
  const d = detail({ reports: [], ...over })
  return { ...d, messages: d.messages.map((m) => ({ ...m, run_id: null })) }
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
})
afterEach(() => vi.unstubAllGlobals())

const composer = () => screen.getByRole('textbox')
const typeAndSend = (text: string) => {
  fireEvent.change(composer(), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}

let tseq = 0
const turn = (id: string) => ({
  emit: (type: string, payload: Record<string, unknown> = {}) =>
    act(() => FakeEventSource.for(`/api/turns/${id}/events`)!.emitRaw({ type, turn_id: id, seq: tseq++, ts: 1000 + tseq, payload })),
})
const run = (id: string) => ({
  emit: (type: RunEventType, stage: Stage | null, payload: Record<string, unknown> = {}, seq = tseq++) =>
    act(() => FakeEventSource.for(`/api/runs/${id}/events`)!.emit({ type, seq, stage, payload }, id)),
})

/** Routes of a backend that has the turn API: a new session, one turn `t1`, answers and stop. */
function turnRoutes(extra: Parameters<typeof routeFetch>[0] = {}) {
  let done = false
  let turnCount = 0
  const state = { get done() { return done }, finish: () => void (done = true) }
  const out = routeFetch({
    '/api/sessions': () => [],
    '/api/kb/spectral': () => mockSpectral,
    'POST /api/sessions': () => newSession(),
    'POST /api/sessions/s9/turns': () => ({ turn_id: `t${++turnCount}` }),
    'POST /api/turns/t1/answer': () => ({ ok: true }),
    'POST /api/turns/t1/approve': () => ({ ok: true }),
    'POST /api/turns/t1/stop': () => ({ ok: true }),
    '/api/sessions/s9': () => newSession(done ? { reports: [{ version: 1, run_id: 'r1' }] } : {}),
    '/api/runs/r1/report': () => (done ? liveReport('r1') : { status: 409, body: { detail: 'run is still running' } }),
    ...extra,
  })
  return { ...out, state }
}
/** The body of the last POST to `url`. */
const bodyOf = (fetchMock: ReturnType<typeof routeFetch>['fetchMock'], url: string) => {
  const call = fetchMock.mock.calls.filter(([u, i]) => u === url && i?.method === 'POST').at(-1)
  return call ? JSON.parse(String(call[1]?.body)) : undefined
}

describe('an assessment as an assistant turn', () => {
  it('starts a turn for the enquiry and streams the plan, tool rows and the question card into the conversation', async () => {
    const { fetchMock } = turnRoutes()
    renderApp()
    typeAndSend('We want to monitor fat content in milk.')
    await waitFor(() => expect(FakeEventSource.for('/api/turns/t1/events')).toBeDefined())
    expect(bodyOf(fetchMock, '/api/sessions/s9/turns')).toEqual({ text: 'We want to monitor fat content in milk.' })

    const t = turn('t1')
    t.emit('plan', { steps: [{ id: 'p0', label: 'Understand the enquiry', status: 'active' }, { id: 'p1', label: 'Clarify open points', status: 'pending' }] })
    t.emit('tool_started', { call_id: 'c1', tool: 'assess.prepare', label: 'Reading the enquiry' })
    t.emit('tool_finished', { call_id: 'c1', tool: 'assess.prepare', summary: '3 candidates', ms: 2900, ok: true })
    t.emit('verdict', preview as unknown as Record<string, unknown>)
    t.emit('question', { question_id: 'qq1', title: '1 question that changes the recommendation', questions: [optics] })

    const conversation = within(screen.getByTestId('conversation'))
    fireEvent.click(await conversation.findByRole('button', { name: 'Understand the enquiry' }))
    expect(conversation.getByRole('list', { name: 'Analysis steps' })).toHaveTextContent('3 candidates')
    const card = conversation.getByRole('region', { name: '1 question that changes the recommendation' })
    expect(within(card).getByRole('radiogroup', { name: optics.text })).toBeInTheDocument()
    expect(within(card).getByRole('group', { name: 'Verdict preview' })).toHaveTextContent('Insufficient information')
    // the turn is running: the composer offers Stop, not Send
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
    // the pipeline step list is not shown: there is no run yet
    expect(screen.queryByRole('list', { name: 'Pipeline stages' })).toBeNull()
  })

  it('clicking an option and Apply posts the answers; the turn goes on', async () => {
    const { fetchMock } = turnRoutes()
    renderApp()
    typeAndSend('We want to monitor fat content in milk.')
    await waitFor(() => expect(FakeEventSource.for('/api/turns/t1/events')).toBeDefined())
    const t = turn('t1')
    t.emit('question', { question_id: 'qq1', title: 'Questions', questions: [optics] })

    fireEvent.click(await screen.findByRole('radio', { name: /Turbid or opaque/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply answers' }))
    await waitFor(() => expect(bodyOf(fetchMock, '/api/turns/t1/answer')).toEqual({ question_id: 'qq1', answers: { optics: { value: 'turbid' } } }))
    // the card now summarises what was applied
    expect(await screen.findByRole('heading', { name: 'Answers applied' })).toBeInTheDocument()
    expect(screen.queryByRole('radio')).toBeNull()
  })

  it('Skip marks every question "not known yet" (they go to the report as questions for the client)', async () => {
    const { fetchMock } = turnRoutes()
    renderApp()
    typeAndSend('We want to monitor fat content in milk.')
    await waitFor(() => expect(FakeEventSource.for('/api/turns/t1/events')).toBeDefined())
    turn('t1').emit('question', { question_id: 'qq1', title: 'Questions', questions: [optics] })
    fireEvent.click(await screen.findByRole('button', { name: 'Skip' }))
    await waitFor(() => expect(bodyOf(fetchMock, '/api/turns/t1/answer')).toEqual({ question_id: 'qq1', answers: { optics: { unknown: true } } }))
    expect(await screen.findByRole('heading', { name: 'Questions skipped' })).toBeInTheDocument()
  })

  it('the Stop button stops the turn and Send comes back', async () => {
    const { fetchMock } = turnRoutes()
    renderApp()
    typeAndSend('We want to monitor fat content in milk.')
    await waitFor(() => expect(FakeEventSource.for('/api/turns/t1/events')).toBeDefined())
    turn('t1').emit('message_delta', { text: 'Working on it' })
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => u === '/api/turns/t1/stop' && i?.method === 'POST')).toBe(true))
    expect(await screen.findByText(/Stopped\./)).toBeInTheDocument()
    // the turn reports its status to the composer one render later
    expect(await screen.findByRole('button', { name: 'Send' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  })

  it('a report event attaches the report pane to the run; engine_ready fills the header and candidates at once, section_ready the tabs', async () => {
    const t = turnRoutes()
    let partial = false
    // a backend that serves what is verified so far while the run goes on
    t.fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
      if (method === 'POST' && url === '/api/sessions') return ok(newSession())
      if (method === 'POST' && url === '/api/sessions/s9/turns') return ok({ turn_id: 't1' })
      if (url === '/api/sessions') return ok([])
      if (url === '/api/kb/spectral') return ok(mockSpectral)
      if (url === '/api/sessions/s9') return ok(newSession(t.state.done ? { reports: [{ version: 1, run_id: 'r1' }] } : {}))
      if (url === '/api/runs/r1/report') {
        if (t.state.done) return ok(liveReport('r1'))
        if (partial) return ok({ run_id: 'r1', direct_answer: mockReport.direct_answer, findings: mockFindings })
        return ok({ detail: 'run is still running' }, 409)
      }
      return ok({ detail: 'not found' }, 404)
    })
    renderApp()
    typeAndSend('We want to monitor fat content in milk.')
    await waitFor(() => expect(FakeEventSource.for('/api/turns/t1/events')).toBeDefined())
    // before any run: the pane waits for the verdict
    expect(screen.getByRole('region', { name: 'Run progress' })).toHaveTextContent('Reading the enquiry')

    const tt = turn('t1')
    tt.emit('verdict', preview as unknown as Record<string, unknown>)
    // the engine's preview already fills the report: status, key facts, candidates; the other sections are skeletons
    const pane = await screen.findByTestId('report-pane')
    expect(within(pane).getByText('Status: Insufficient information')).toBeInTheDocument()
    expect(within(pane).queryByText('Engine preview')).toBeNull()
    expect(within(pane).getByRole('list', { name: 'Candidate methods from the rules engine' })).toHaveTextContent('Raman probe')
    expect(within(pane).getByRole('status', { name: 'Loading direct answer' })).toBeInTheDocument()

    // the turn starts the report run: the pane attaches to its stream
    tt.emit('report', { run_id: 'r1', version: 1 })
    await waitFor(() => expect(FakeEventSource.for('/api/runs/r1/events')).toBeDefined())
    const r = run('r1')
    r.emit('stage_started', 'rules')
    r.emit('engine_ready', 'rules', { ...preview, status: 'PROVISIONAL' })
    expect(await within(screen.getByTestId('report-pane')).findByText('Status: Provisional')).toBeInTheDocument()
    expect(within(screen.getByTestId('report-pane')).getByText('Writing the report…')).toBeInTheDocument()
    // the conversation shows the run as one row of the turn (not a second step list)
    expect(screen.getByRole('button', { name: /Open report/ })).toHaveTextContent('Open report v1')

    partial = true
    r.emit('section_ready', 'write', { section: 'answer', paths: ['direct_answer'] })
    expect((await within(screen.getByTestId('report-pane')).findAllByText('Start with a comparison study.')).length).toBeGreaterThan(0)
    expect(within(screen.getByTestId('report-pane')).queryByRole('status', { name: 'Loading direct answer' })).toBeNull()
    expect(screen.getByRole('list', { name: 'Analysis steps', hidden: true })).toHaveTextContent('Writing the report')

    t.state.finish()
    r.emit('run_completed', 'render', { status: 'PROVISIONAL' })
    expect(await screen.findByRole('region', { name: 'Recommendations' })).toBeInTheDocument()
    expect(within(screen.getByTestId('report-pane')).queryByText('Writing the report…')).toBeNull()
    expect(within(screen.getByTestId('report-pane')).getByRole('tablist', { name: 'Report sections' })).toBeInTheDocument()
  })

  it('a finished turn shows its message with citation chips and the next steps; a click sends {action, payload}', async () => {
    const { fetchMock } = turnRoutes()
    renderApp()
    typeAndSend('We want to monitor fat content in milk.')
    await waitFor(() => expect(FakeEventSource.for('/api/turns/t1/events')).toBeDefined())
    const t = turn('t1')
    t.emit('message_delta', { text: 'NIR fits [S01-p10-nir-range].' })
    t.emit('suggestions', { options: [{ label: 'Draft client e-mail', action: 'draft_email' }, { label: 'Compare NIR vs Raman', action: 'compare', payload: { a: 'NIR', b: 'Raman' } }] })
    t.emit('turn_completed', { message: 'NIR fits [S01-p10-nir-range].', citations: { 'S01-p10-nir-range': 'S01 p.10' } })

    expect(await screen.findByRole('button', { name: 'Show source S01 p.10' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
    const next = screen.getByRole('group', { name: 'Next steps' })
    fireEvent.click(within(next).getByRole('button', { name: 'Compare NIR vs Raman' }))
    await waitFor(() => expect(bodyOf(fetchMock, '/api/sessions/s9/turns')).toEqual({ action: 'compare', payload: { a: 'NIR', b: 'Raman' } }))
    // the click shows as the scientist's own message
    expect(await screen.findAllByText('Compare NIR vs Raman')).not.toHaveLength(0)
  })

  it('a requested approval pauses the turn on a card; Approve posts the decision', async () => {
    const { fetchMock } = turnRoutes()
    renderApp()
    typeAndSend('We want to monitor fat content in milk.')
    await waitFor(() => expect(FakeEventSource.for('/api/turns/t1/events')).toBeDefined())
    turn('t1').emit('approval', { approval_id: 'ap1', action: 'web.search', label: 'Search the literature?', why: 'The AFS evidence is thin.', cost_calls: 3 })
    const card = await screen.findByRole('region', { name: 'Approval needed' })
    expect(card).toHaveTextContent('Uses about 3 extra calls')
    fireEvent.click(within(card).getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(bodyOf(fetchMock, '/api/turns/t1/approve')).toEqual({ approval_id: 'ap1', approved: true }))
    expect(await screen.findByRole('heading', { name: 'Approved: Search the literature?' })).toBeInTheDocument()
  })

  it('a failed turn says so', async () => {
    turnRoutes()
    renderApp()
    typeAndSend('We want to monitor fat content in milk.')
    await waitFor(() => expect(FakeEventSource.for('/api/turns/t1/events')).toBeDefined())
    turn('t1').emit('turn_failed', { error: 'Provider timed out' })
    expect(await screen.findByRole('alert')).toHaveTextContent('Provider timed out')
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
  })
})

describe('a backend without the turn API', () => {
  it('an enquiry falls back to a plain run (404 on /turns)', async () => {
    const { calls } = routeFetch({
      '/api/sessions': () => [],
      '/api/kb/spectral': () => mockSpectral,
      'POST /api/sessions': () => detail({ messages: [], reports: [] }),
      'POST /api/sessions/s9/runs': () => ({ run_id: 'r9' }),
      '/api/sessions/s9': () => detail({ reports: [] }),
      '/api/runs/r9/report': () => ({ status: 409, body: { detail: 'run is still running' } }),
    })
    renderApp()
    typeAndSend('We want to monitor fat content in milk.')
    await waitFor(() => expect(FakeEventSource.instances.map((e) => e.url)).toContain('/api/runs/r9/events'))
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual(['POST /api/sessions', 'POST /api/sessions/s9/turns', 'POST /api/sessions/s9/runs'])
    expect(screen.getByRole('button', { name: /Working/ })).toHaveAttribute('aria-expanded', 'false')
  })

  it('a follow-up falls back to /messages, and the turn API is not tried again', async () => {
    const stored = detail()
    const { calls } = routeFetch({
      '/api/sessions': () => [stored],
      '/api/kb/spectral': () => mockSpectral,
      '/api/sessions/s9': () => stored,
      '/api/runs/r7/report': () => liveReport('r7'),
      'POST /api/sessions/s9/messages': () => ({ kind: 'answer', text: 'It is the fat globules.', cited_ids: [], tool_calls: [], proposed_facts: [] }),
    })
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Assessments' }))
    fireEvent.click(await screen.findByRole('button', { name: /Dairy line fat content/ }))
    await screen.findByRole('region', { name: 'Recommendations' })

    typeAndSend('Why does fat scatter light?')
    await waitFor(() => expect(screen.getByTestId('conversation')).toHaveTextContent('It is the fat globules.'))
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual(['POST /api/sessions/s9/turns', 'POST /api/sessions/s9/messages'])

    typeAndSend('And protein?')
    await waitFor(() => expect(calls.filter((c) => c === 'POST /api/sessions/s9/messages')).toHaveLength(2))
    expect(calls.filter((c) => c === 'POST /api/sessions/s9/turns')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------- the run stream (CONTRACTS C3)

describe('run stream: engine_ready, section_ready, write / verify / patch', () => {
  let seq = 0
  const ev = (type: RunEventType, stage: Stage | null, payload: Record<string, unknown> = {}): RunEvent => ({ type, run_id: 'r', seq: seq++, ts: 1000 + seq, stage, payload })
  beforeEach(() => {
    seq = 0
  })

  it('engine_ready keeps the preview: status, candidates, questions, spectral methods', () => {
    const s = applyEvents([ev('stage_started', 'rules'), ev('engine_ready', 'rules', preview as unknown as Record<string, unknown>), ev('stage_completed', 'rules', { seconds: 0.1 })], initialPipelineState('r'))
    expect(s.engine?.status).toBe('INSUFFICIENT_INFORMATION')
    expect(s.engine?.candidates.map((c) => [c.method, c.score, c.blocked])).toEqual([['NIR', 5, false], ['Raman', 4, false], ['MIR', 2, true]])
    expect(s.engine?.questions[0].id).toBe('optics')
    expect(s.engine?.spectral_methods).toEqual(['NIR', 'Raman'])
    expect(s.stages.rules.events.map((e) => e.type)).toContain('engine_ready')
  })

  it('section_ready lists the sections that passed verification, once each, in order', () => {
    const s = applyEvents(
      [ev('stage_started', 'write'), ev('section_ready', 'write', { section: 'concept', paths: ['measurement_concept'] }), ev('section_ready', 'write', { section: 'answer', paths: [] }), ev('section_ready', 'write', { section: 'concept', paths: [] })],
      initialPipelineState('r'),
    )
    expect(s.sectionsReady).toEqual(['concept', 'answer'])
    expect(s.status).toBe('running')
  })

  it('write, verify and patch are stages of the run; a stored run with draft / repair shows those instead', () => {
    const fresh = applyEvents(
      ['scope', 'extract', 'normalise', 'rules', 'retrieve', 'write', 'verify', 'patch', 'render'].flatMap((st) => [ev('stage_started', st as Stage), ev('stage_completed', st as Stage, { seconds: 1 })]),
      initialPipelineState('r'),
    )
    expect(stagesRun(fresh)).toEqual(['scope', 'extract', 'normalise', 'rules', 'retrieve', 'write', 'verify', 'patch', 'render'])
    const stored = applyEvents(
      ['scope', 'extract', 'normalise', 'rules', 'retrieve', 'draft', 'verify', 'repair', 'render'].flatMap((st) => [ev('stage_started', st as Stage), ev('stage_completed', st as Stage, { seconds: 1 })]),
      initialPipelineState('r'),
    )
    expect(stagesRun(stored)).toEqual(['scope', 'extract', 'normalise', 'rules', 'retrieve', 'draft', 'verify', 'repair', 'render'])
  })

  it('a repaired event counts on the patch stage', () => {
    const s = applyEvents([ev('stage_started', 'patch'), ev('repaired', 'patch', { remaining: [] })], initialPipelineState('r'))
    expect(s.stages.patch.repaired).toBe(1)
  })
})
