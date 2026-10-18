// The assistant's building blocks: the turn reducer (every C4 event), the useTurn hook, and the cards
// (question, approval, plan, tool activity, message, suggestions) with mouse and keyboard. No network.
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyTurnEvent, initialTurnState, isTurnWaiting, openApproval, openQuestion, turnReducer, type TurnState } from '../assistant/turnReducer'
import { ApprovalCard } from '../components/assistant/ApprovalCard'
import { AssistantMessage } from '../components/assistant/AssistantMessage'
import { PlanCard } from '../components/assistant/PlanCard'
import { QuestionCard } from '../components/assistant/QuestionCard'
import { Suggestions } from '../components/assistant/Suggestions'
import { ToolActivity } from '../components/assistant/ToolActivity'
import { VerdictPreview } from '../components/assistant/VerdictPreview'
import { Composer } from '../components/composer/Composer'
import { useTurn } from '../hooks/useTurn'
import type { ClarifyQuestion, EnginePreview, QuestionAnswer, TurnEvent, TurnEventType } from '../types'
import { FakeEventSource, routeFetch } from './helpers'

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
})
afterEach(() => vi.unstubAllGlobals())

// ---------------------------------------------------------------- fixtures

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
    { value: 'powder', label: 'Powder or solid', effect: 'reflection probe' },
  ],
}
const gmp: ClarifyQuestion = {
  id: 'gmp',
  slot: 'use_context',
  stream_id: null,
  text: 'Is the result used for batch release (GMP)?',
  why: 'It sets how strict the validation plan is.',
  impact: 'STATUS_CHANGE',
  options: [
    { value: 'release', label: 'Yes, for release', effect: 'stricter validation plan' },
    { value: 'monitoring', label: 'No, monitoring only', effect: 'screening plan is enough' },
  ],
}
const targets: ClarifyQuestion = {
  id: 'targets',
  slot: 'targets',
  stream_id: null,
  text: 'Which constituents must be measured?',
  why: '',
  impact: 'TECHNIQUE_CHANGE',
  multi: true,
  options: [
    { value: 'fat', label: 'Fat', effect: 'needs the NIR range' },
    { value: 'protein', label: 'Protein', effect: '' },
    { value: 'lactose', label: 'Lactose', effect: '' },
  ],
}
const preview: EnginePreview = {
  status: 'INSUFFICIENT_INFORMATION',
  candidates: [
    { method: 'Raman', technique: 'Raman probe', score: 4, blocked: false },
    { method: 'NIR', technique: 'diffuse reflection probe', score: 5.5, blocked: false },
    { method: 'MIR', technique: 'ATR probe', score: 9, blocked: true },
    { method: 'UV-Vis', technique: 'immersion probe', score: 1, blocked: false },
  ],
  questions: [optics, gmp],
}

const TURN = 't1'
let seq = 0
const ev = (type: TurnEventType, payload: Record<string, unknown> = {}, ts = 1000 + seq): TurnEvent => ({ type, turn_id: TURN, seq: seq++, ts, payload })
const fold = (events: TurnEvent[], from: TurnState = initialTurnState(TURN)) => events.reduce(applyTurnEvent, from)
const resetSeq = () => {
  seq = 0
}

// ---------------------------------------------------------------- turn reducer

describe('turn reducer', () => {
  beforeEach(resetSeq)

  it('starts idle and becomes running on the first event', () => {
    const s0 = initialTurnState(TURN)
    expect(s0.status).toBe('idle')
    expect(fold([ev('message_delta', { text: 'Hi' })]).status).toBe('running')
  })

  it('message_delta concatenates into one streamed message; a tool in between starts a new one', () => {
    let s = fold([ev('message_delta', { text: 'Hello ' }), ev('message_delta', { text: 'world.' })])
    expect(s.items).toEqual([{ kind: 'text', id: expect.any(String), text: 'Hello world.' }])
    s = fold([ev('tool_started', { call_id: 'a', tool: 'kb.search', label: 'Searched' }), ev('message_delta', { text: 'After.' })], s)
    expect(s.items.map((i) => i.kind)).toEqual(['text', 'tool', 'text'])
  })

  it('plan replaces the whole plan each time and times the steps from the event clock', () => {
    const steps = (a: string, b: string) => ({
      steps: [
        { id: 'p0', label: 'Understand', status: a },
        { id: 'p1', label: 'Clarify', status: b, detail: '2 questions' },
      ],
    })
    let s = fold([ev('plan', steps('active', 'pending'), 100)])
    expect(s.plan.map((p) => p.status)).toEqual(['active', 'pending'])
    expect(s.plan[1].detail).toBe('2 questions')
    s = fold([ev('plan', steps('done', 'active'), 103.5)], s)
    expect(s.plan.map((p) => p.status)).toEqual(['done', 'active'])
    expect(s.planTimes.p0.seconds).toBeCloseTo(3.5)
    expect(s.planTimes.p1.seconds).toBeNull()
    // a step that arrives already done has no duration to show
    expect(fold([ev('plan', steps('done', 'pending'), 110)], initialTurnState(TURN)).planTimes.p0.seconds).toBeNull()
  })

  it('an unknown plan status reads as pending', () => {
    const s = fold([ev('plan', { steps: [{ id: 'x', label: 'X', status: 'whatever' }] })])
    expect(s.plan[0].status).toBe('pending')
  })

  it('tool_started then tool_finished updates one row with summary, ms and ok', () => {
    let s = fold([ev('tool_started', { call_id: 'c1', tool: 'assess.prepare', label: 'Reading the enquiry' })])
    expect(s.items[0]).toMatchObject({ kind: 'tool', tool: { callId: 'c1', status: 'running', label: 'Reading the enquiry' } })
    s = fold([ev('tool_finished', { call_id: 'c1', tool: 'assess.prepare', summary: '3 candidates', ms: 2900, ok: true })], s)
    expect(s.items).toHaveLength(1)
    expect(s.items[0]).toMatchObject({ tool: { status: 'done', summary: '3 candidates', ms: 2900, label: 'Reading the enquiry' } })
    s = fold([ev('tool_started', { call_id: 'c2', tool: 'web.search', label: 'Searching' }), ev('tool_finished', { call_id: 'c2', tool: 'web.search', summary: 'timed out', ms: 10, ok: false })], s)
    expect(s.items[1]).toMatchObject({ tool: { status: 'failed' } })
  })

  it('question opens a card the turn waits on; the next event of the turn closes it', () => {
    let s = fold([ev('question', { question_id: 'qq', title: '2 questions', questions: [optics, gmp] })])
    expect(openQuestion(s)).toMatchObject({ questionId: 'qq', title: '2 questions', resolved: false })
    expect(openQuestion(s)!.questions).toHaveLength(2)
    expect(isTurnWaiting(s)).toBe(true)
    s = fold([ev('verdict', preview as unknown as Record<string, unknown>)], s)
    expect(openQuestion(s)).toBeNull()
    expect(isTurnWaiting(s)).toBe(false)
  })

  it('approval opens a card the turn waits on', () => {
    const s = fold([ev('approval', { approval_id: 'ap', action: 'web.search', label: 'Search the literature?', why: 'Thin evidence.', cost_calls: 3 })])
    expect(openApproval(s)).toEqual({ approvalId: 'ap', action: 'web.search', label: 'Search the literature?', why: 'Thin evidence.', costCalls: 3, resolved: false })
    expect(isTurnWaiting(s)).toBe(true)
  })

  it('verdict keeps the latest engine preview (status, candidates, questions)', () => {
    let s = fold([ev('verdict', preview as unknown as Record<string, unknown>)])
    expect(s.verdict?.status).toBe('INSUFFICIENT_INFORMATION')
    expect(s.verdict?.candidates).toHaveLength(4)
    expect(s.verdict?.questions[0].id).toBe('optics')
    s = fold([ev('verdict', { status: 'PROVISIONAL', candidates: [], questions: [] })], s)
    expect(s.verdict?.status).toBe('PROVISIONAL')
  })

  it('report records the run the turn started', () => {
    const s = fold([ev('report', { run_id: 'r1', version: 2 })])
    expect(s.report).toEqual({ runId: 'r1', version: 2 })
  })

  it('suggestions list the clickable next steps', () => {
    const s = fold([ev('suggestions', { options: [{ label: 'Draft e-mail', action: 'draft_email' }, { label: 'Ask', action: 'ask', payload: 'Why NIR?' }] })])
    expect(s.suggestions).toEqual([
      { label: 'Draft e-mail', action: 'draft_email', payload: undefined },
      { label: 'Ask', action: 'ask', payload: 'Why NIR?' },
    ])
  })

  it('turn_completed ends the turn: final message, citation labels, web sources; no step stays active', () => {
    const s = fold([
      ev('plan', { steps: [{ id: 'p', label: 'Write', status: 'active' }] }),
      ev('message_delta', { text: 'Streaming…' }),
      ev('turn_completed', { message: 'NIR fits [S01-p17].', citations: { 'S01-p17': 'S01 p.17' }, web_sources: [{ url: 'https://doi.org/x', title: 'T', domain: 'doi.org' }] }),
    ])
    expect(s.status).toBe('completed')
    expect(s.message).toBe('NIR fits [S01-p17].')
    expect(s.items).toEqual([{ kind: 'text', id: expect.any(String), text: 'NIR fits [S01-p17].' }])
    expect(s.citations).toEqual({ 'S01-p17': 'S01 p.17' })
    expect(s.webSources[0].domain).toBe('doi.org')
    expect(s.plan[0].status).toBe('done')
  })

  it('turn_completed without any streamed text still shows the message', () => {
    const s = fold([ev('turn_completed', { message: 'Done.' })])
    expect(s.items).toEqual([{ kind: 'text', id: expect.any(String), text: 'Done.' }])
  })

  it('turn_failed records the error and closes open cards', () => {
    const s = fold([ev('question', { question_id: 'q', title: 't', questions: [optics] }), ev('turn_failed', { error: 'Provider timed out' })])
    expect(s.status).toBe('failed')
    expect(s.error).toBe('Provider timed out')
    expect(openQuestion(s)).toBeNull()
  })

  it('ignores replayed events (seq already applied) and events of another turn', () => {
    const first = ev('message_delta', { text: 'A' })
    let s = fold([first])
    s = applyTurnEvent(s, first)
    s = applyTurnEvent(s, { ...ev('message_delta', { text: 'B' }), seq: 0 })
    expect(s.items[0]).toMatchObject({ text: 'A' })
    s = applyTurnEvent(s, { ...ev('message_delta', { text: 'X' }), turn_id: 'other' })
    expect(s.items[0]).toMatchObject({ text: 'A' })
  })

  it('answered and decided mark the cards locally; stopped ends a running turn', () => {
    let s = fold([ev('question', { question_id: 'qq', title: 't', questions: [optics] }), ev('approval', { approval_id: 'ap', action: 'x', label: 'L', why: '', cost_calls: 1 })])
    const answers: Record<string, QuestionAnswer> = { optics: { value: 'turbid' } }
    s = turnReducer(s, { kind: 'answered', questionId: 'qq', answers })
    expect(s.items.find((i) => i.kind === 'question')).toMatchObject({ question: { resolved: true, answers } })
    s = turnReducer(s, { kind: 'decided', approvalId: 'ap', approved: false })
    expect(s.items.find((i) => i.kind === 'approval')).toMatchObject({ approval: { resolved: true, decision: 'declined' } })
    s = turnReducer(s, { kind: 'stopped' })
    expect(s.status).toBe('stopped')
    // a finished turn stays as it was
    const done = fold([ev('turn_completed', { message: 'ok' })], initialTurnState(TURN))
    expect(turnReducer(done, { kind: 'stopped' }).status).toBe('completed')
  })
})

// ---------------------------------------------------------------- useTurn

describe('useTurn', () => {
  beforeEach(resetSeq)

  it('streams events into the state and closes the stream at the end of the turn', () => {
    const { result } = renderHook(() => useTurn(TURN))
    const es = FakeEventSource.for('/api/turns/t1/events')!
    act(() => {
      es.emitRaw(ev('plan', { steps: [{ id: 'p', label: 'Understand', status: 'active' }] }))
      es.emitRaw(ev('message_delta', { text: 'Hello' }))
    })
    expect(result.current.state.plan).toHaveLength(1)
    expect(result.current.state.status).toBe('running')
    act(() => es.emitRaw(ev('turn_completed', { message: 'Hello there.', citations: {} })))
    expect(result.current.state.status).toBe('completed')
    expect(result.current.connection).toBe('closed')
    expect(es.readyState).toBe(2)
  })

  it('ignores malformed frames', () => {
    const { result } = renderHook(() => useTurn(TURN))
    act(() => FakeEventSource.for('/api/turns/t1/events')!.onmessage?.(new MessageEvent('message', { data: ': keep-alive' })))
    expect(result.current.state.lastSeq).toBe(-1)
  })

  it('answer() posts {question_id, answers} and marks the card answered', async () => {
    const { fetchMock } = routeFetch({ 'POST /api/turns/t1/answer': () => ({ ok: true }) })
    const { result } = renderHook(() => useTurn(TURN))
    act(() => FakeEventSource.for('/api/turns/t1/events')!.emitRaw(ev('question', { question_id: 'qq', title: 't', questions: [optics] })))
    await act(async () => result.current.answer('qq', { optics: { value: 'turbid' } }))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/turns/t1/answer')
    expect(JSON.parse(String(init?.body))).toEqual({ question_id: 'qq', answers: { optics: { value: 'turbid' } } })
    expect(result.current.state.items[0]).toMatchObject({ question: { resolved: true } })
  })

  it('approve() posts {approval_id, approved}; stop() posts and ends the turn', async () => {
    const { fetchMock } = routeFetch({ 'POST /api/turns/t1/approve': () => ({ ok: true }), 'POST /api/turns/t1/stop': () => ({ ok: true }) })
    const { result } = renderHook(() => useTurn(TURN))
    act(() => FakeEventSource.for('/api/turns/t1/events')!.emitRaw(ev('approval', { approval_id: 'ap', action: 'web.search', label: 'L', why: '', cost_calls: 3 })))
    await act(async () => result.current.approve('ap', true))
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ approval_id: 'ap', approved: true })
    await act(async () => result.current.stop())
    expect(fetchMock.mock.calls[1][0]).toBe('/api/turns/t1/stop')
    expect(result.current.state.status).toBe('stopped')
  })

  it('a failed answer keeps the card open and reports the error', async () => {
    routeFetch({ 'POST /api/turns/t1/answer': () => ({ status: 500, body: { detail: 'boom' } }) })
    const { result } = renderHook(() => useTurn(TURN))
    act(() => FakeEventSource.for('/api/turns/t1/events')!.emitRaw(ev('question', { question_id: 'qq', title: 't', questions: [optics] })))
    await act(async () => result.current.answer('qq', { optics: { unknown: true } }))
    expect(result.current.actionError).toMatch(/500/)
    expect(openQuestion(result.current.state)).not.toBeNull()
  })
})

// ---------------------------------------------------------------- QuestionCard

function Card({ questions, onApply = () => {}, onSkip = () => {}, verdict = preview, autoFocus = false }: { questions: ClarifyQuestion[]; onApply?: (a: Record<string, QuestionAnswer>) => void; onSkip?: () => void; verdict?: EnginePreview | null; autoFocus?: boolean }) {
  return <QuestionCard title="2 questions that change the recommendation" questions={questions} verdict={verdict} onApply={onApply} onSkip={onSkip} autoFocus={autoFocus} />
}
const group = (q: ClarifyQuestion) => within(screen.getByRole(q.multi ? 'group' : 'radiogroup', { name: q.text }))
const apply = () => screen.getByRole('button', { name: 'Apply answers' })

describe('QuestionCard', () => {
  it('shows each question with its options, the effect of each, and always "Not known yet" and "Other…"', () => {
    render(<Card questions={[optics, gmp]} />)
    expect(screen.getByRole('heading', { name: '2 questions that change the recommendation' })).toBeInTheDocument()
    const g = group(optics)
    expect(g.getAllByRole('radio').map((r) => r.textContent?.replace(/\d$/, ''))).toEqual([
      'Clear liquidtransmission probe',
      'Turbid or opaquediffuse reflection probe',
      'Powder or solidreflection probe',
      'Not known yet',
      'Other…',
    ])
    expect(group(gmp).getByRole('radio', { name: /Not known yet/ })).toBeInTheDocument()
    expect(screen.getByText('It decides the probe geometry.')).toBeInTheDocument()
    expect(apply()).toBeDisabled()
  })

  it('click picks one option per question; Apply sends value for picked and unknown for the rest', () => {
    const onApply = vi.fn()
    render(<Card questions={[optics, gmp]} onApply={onApply} />)
    fireEvent.click(group(optics).getByRole('radio', { name: /Clear liquid/ }))
    fireEvent.click(group(optics).getByRole('radio', { name: /Turbid or opaque/ }))
    expect(group(optics).getByRole('radio', { name: /Turbid or opaque/ })).toHaveAttribute('aria-checked', 'true')
    expect(group(optics).getByRole('radio', { name: /Clear liquid/ })).toHaveAttribute('aria-checked', 'false')
    expect(apply()).toBeEnabled()
    fireEvent.click(apply())
    expect(onApply).toHaveBeenCalledWith({ optics: { value: 'turbid' }, gmp: { unknown: true } })
  })

  it('"Not known yet" answers {unknown: true}', () => {
    const onApply = vi.fn()
    render(<Card questions={[optics, gmp]} onApply={onApply} />)
    fireEvent.click(group(optics).getByRole('radio', { name: /Not known yet/ }))
    fireEvent.click(group(gmp).getByRole('radio', { name: /Yes, for release/ }))
    fireEvent.click(apply())
    expect(onApply).toHaveBeenCalledWith({ optics: { unknown: true }, gmp: { value: 'release' } })
  })

  it('"Other…" opens a text field and answers {other: text}; empty text is not an answer', () => {
    const onApply = vi.fn()
    render(<Card questions={[optics]} onApply={onApply} />)
    fireEvent.click(group(optics).getByRole('radio', { name: /Other/ }))
    const field = screen.getByRole('textbox', { name: /your answer/ })
    expect(field).toHaveFocus()
    expect(apply()).toBeDisabled()
    fireEvent.change(field, { target: { value: '  opaque with solids ' } })
    expect(apply()).toBeEnabled()
    fireEvent.click(apply())
    expect(onApply).toHaveBeenCalledWith({ optics: { other: 'opaque with solids' } })
  })

  it('a multi question uses checkboxes and answers {values: [...]}', () => {
    const onApply = vi.fn()
    render(<Card questions={[targets]} onApply={onApply} />)
    const fat = group(targets).getByRole('checkbox', { name: /Fat/ })
    fireEvent.click(fat)
    fireEvent.click(group(targets).getByRole('checkbox', { name: /Lactose/ }))
    expect(fat).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(fat) // toggles off
    fireEvent.click(group(targets).getByRole('checkbox', { name: /Protein/ }))
    fireEvent.click(apply())
    expect(onApply).toHaveBeenCalledWith({ targets: { values: ['lactose', 'protein'] } })
  })

  it('shows what the picked options would change, under "With your picks"', () => {
    render(<Card questions={[optics, gmp]} />)
    fireEvent.click(group(optics).getByRole('radio', { name: /Turbid or opaque/ }))
    fireEvent.click(group(gmp).getByRole('radio', { name: /Yes, for release/ }))
    const effects = screen.getByText('With your picks').parentElement!
    expect(effects).toHaveTextContent('diffuse reflection probe; stricter validation plan')
  })

  it('keyboard: ↓/↑ move and pick, 1–9 pick, Enter applies, Esc skips', () => {
    const onApply = vi.fn()
    const onSkip = vi.fn()
    render(<Card questions={[optics, gmp]} onApply={onApply} onSkip={onSkip} />)
    const clear = group(optics).getByRole('radio', { name: /Clear liquid/ })
    clear.focus()
    fireEvent.keyDown(clear, { key: 'ArrowDown' })
    const turbid = group(optics).getByRole('radio', { name: /Turbid or opaque/ })
    expect(turbid).toHaveFocus()
    expect(turbid).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(turbid, { key: 'ArrowDown' })
    expect(group(optics).getByRole('radio', { name: /Powder or solid/ })).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(turbid).toHaveAttribute('aria-checked', 'true')
    // number keys pick within the question the focus is in
    fireEvent.keyDown(turbid, { key: '4' }) // "Not known yet"
    expect(group(optics).getByRole('radio', { name: /Not known yet/ })).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(document.activeElement!, { key: '1' })
    expect(group(optics).getByRole('radio', { name: /Clear liquid/ })).toHaveAttribute('aria-checked', 'true')
    // the second question: 2 picks "No, monitoring only"
    const release = group(gmp).getByRole('radio', { name: /Yes, for release/ })
    release.focus()
    fireEvent.keyDown(release, { key: '2' })
    expect(group(gmp).getByRole('radio', { name: /No, monitoring only/ })).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' })
    expect(onApply).toHaveBeenCalledWith({ optics: { value: 'clear' }, gmp: { value: 'monitoring' } })
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(onSkip).toHaveBeenCalledTimes(1)
  })

  it('Enter on an option nothing was picked for picks it and applies', () => {
    const onApply = vi.fn()
    render(<Card questions={[gmp]} onApply={onApply} />)
    const monitoring = group(gmp).getByRole('radio', { name: /No, monitoring only/ })
    monitoring.focus()
    fireEvent.keyDown(monitoring, { key: 'Enter' })
    expect(onApply).toHaveBeenCalledWith({ gmp: { value: 'monitoring' } })
  })

  it('the number keys do not reach the report tabs behind the card', () => {
    const onDocument = vi.fn()
    document.addEventListener('keydown', onDocument)
    render(<Card questions={[optics]} />)
    const clear = group(optics).getByRole('radio', { name: /Clear liquid/ })
    clear.focus()
    fireEvent.keyDown(clear, { key: '2' })
    document.removeEventListener('keydown', onDocument)
    expect(onDocument).not.toHaveBeenCalled()
  })

  it('in the "Other…" field the first Esc leaves the field, the second skips; keys type normally', () => {
    const onSkip = vi.fn()
    render(<Card questions={[optics]} onSkip={onSkip} />)
    fireEvent.click(group(optics).getByRole('radio', { name: /Other/ }))
    const field = screen.getByRole('textbox', { name: /your answer/ })
    fireEvent.keyDown(field, { key: '3' })
    expect(group(optics).getByRole('radio', { name: /Other/ })).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(onSkip).not.toHaveBeenCalled()
    expect(group(optics).getByRole('radio', { name: /Other/ })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(onSkip).toHaveBeenCalledTimes(1)
  })

  it('Skip leaves every question to the caller to mark unknown', () => {
    const onSkip = vi.fn()
    render(<Card questions={[optics]} onSkip={onSkip} />)
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(onSkip).toHaveBeenCalled()
  })

  it('takes the keyboard when it appears paused on the turn', () => {
    render(<Card questions={[optics]} autoFocus />)
    expect(group(optics).getByRole('radio', { name: /Clear liquid/ })).toHaveFocus()
  })

  it('an answered card is a summary of what was applied', () => {
    render(
      <QuestionCard title="t" questions={[optics, gmp]} verdict={preview} resolved answers={{ optics: { value: 'turbid' }, gmp: { unknown: true } }} onApply={() => {}} onSkip={() => {}} />,
    )
    expect(screen.getByRole('heading', { name: 'Answers applied' })).toBeInTheDocument()
    expect(screen.getByText('Turbid or opaque')).toBeInTheDocument()
    expect(screen.getByText('Not known yet')).toBeInTheDocument()
    expect(screen.queryByRole('radio')).toBeNull()
  })

  it('skipping every question reads as skipped', () => {
    render(<QuestionCard title="t" questions={[optics]} verdict={null} resolved answers={{ optics: { unknown: true } }} onApply={() => {}} onSkip={() => {}} />)
    expect(screen.getByRole('heading', { name: 'Questions skipped' })).toBeInTheDocument()
  })
})

describe('VerdictPreview', () => {
  it('shows the status pill and the top three open candidates, blocked last', () => {
    render(<VerdictPreview verdict={preview} />)
    const view = screen.getByRole('group', { name: 'Verdict preview' })
    expect(within(view).getByRole('status')).toHaveTextContent('Insufficient information')
    const rows = within(within(view).getByRole('list', { name: 'Top candidates' })).getAllByRole('listitem')
    expect(rows.map((r) => r.textContent)).toEqual(['NIRdiffuse reflection probe5.5', 'RamanRaman probe4', 'UV-Visimmersion probe1'])
    expect(view).toHaveTextContent('+1 more')
  })

  it('says so before the engine has run', () => {
    render(<VerdictPreview verdict={null} />)
    expect(screen.getByText(/appears once the engine has run/)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------- ApprovalCard

describe('ApprovalCard', () => {
  const card = (over: Partial<Parameters<typeof ApprovalCard>[0]> = {}) => (
    <ApprovalCard label="Search scholarly literature?" why="The AFS evidence is thin." costCalls={3} onApprove={() => {}} onSkip={() => {}} {...over} />
  )

  it('shows the action, why and about how many calls it uses; Approve and Skip', () => {
    const onApprove = vi.fn()
    const onSkip = vi.fn()
    render(card({ onApprove, onSkip }))
    expect(screen.getByRole('heading', { name: 'Search scholarly literature?' })).toBeInTheDocument()
    expect(screen.getByText('The AFS evidence is thin.')).toBeInTheDocument()
    expect(screen.getByText(/Uses about/)).toHaveTextContent('Uses about 3 extra calls.')
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onApprove).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(onSkip).toHaveBeenCalledTimes(1)
  })

  it('says "1 extra call" in the singular and nothing when the cost is unknown', () => {
    const { rerender } = render(card({ costCalls: 1 }))
    expect(screen.getByText(/Uses about/)).toHaveTextContent('1 extra call.')
    rerender(card({ costCalls: null }))
    expect(screen.queryByText(/Uses about/)).toBeNull()
  })

  it('Esc skips; the Approve button takes focus when the turn waits on it', () => {
    const onSkip = vi.fn()
    render(card({ onSkip, autoFocus: true }))
    expect(screen.getByRole('button', { name: 'Approve' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Approve' }), { key: 'Escape' })
    expect(onSkip).toHaveBeenCalled()
  })

  it('busy disables both buttons; a decided card is one line', () => {
    const { rerender } = render(card({ busy: true }))
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Skip' })).toBeDisabled()
    rerender(card({ resolved: true, decision: 'declined' }))
    expect(screen.getByRole('heading', { name: 'Skipped: Search scholarly literature?' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    rerender(card({ resolved: true, decision: 'approved' }))
    expect(screen.getByRole('heading', { name: 'Approved: Search scholarly literature?' })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------- PlanCard, ToolActivity, message, suggestions

describe('PlanCard', () => {
  const steps = [
    { id: 'a', label: 'Understand the enquiry', status: 'done' as const },
    { id: 'b', label: 'Clarify open points', status: 'active' as const, detail: '2 questions' },
    { id: 'c', label: 'Write the assessment', status: 'pending' as const },
    { id: 'd', label: 'Verify every sentence', status: 'skipped' as const },
  ]

  it('lists every step with its state and the duration of a done step', () => {
    render(<PlanCard steps={steps} times={{ a: { start: 0, seconds: 3.14 } }} />)
    const items = within(screen.getByRole('list')).getAllByRole('listitem')
    expect(items.map((i) => i.getAttribute('data-status'))).toEqual(['done', 'active', 'pending', 'skipped'])
    expect(items[0]).toHaveTextContent('3.1 s')
    expect(items[1]).toHaveAttribute('aria-current', 'step')
    expect(items[1]).toHaveTextContent('2 questions')
    expect(within(items[0]).getByText('Done')).toHaveClass('sr-only')
    expect(screen.getByText('Clarify open points', { selector: '.as-muted' })).toBeInTheDocument() // the active step in the header
  })

  it('a finished turn folds the plan to one line that opens on click', () => {
    render(<PlanCard steps={steps.map((s) => ({ ...s, status: 'done' as const }))} finished />)
    expect(screen.queryByRole('list')).toBeNull()
    const toggle = screen.getByRole('button', { name: /Plan/ })
    expect(toggle).toHaveTextContent('4 of 4 done')
    fireEvent.click(toggle)
    expect(screen.getAllByRole('listitem')).toHaveLength(4)
  })

  it('a skipped step counts as settled in the folded line', () => {
    const settled = steps.map((s, i) => ({ ...s, status: i === 1 ? ('skipped' as const) : ('done' as const) }))
    render(<PlanCard steps={settled} finished />)
    expect(screen.getByRole('button', { name: /Plan/ })).toHaveTextContent('3 of 3 done · 1 skipped')
  })

  it('renders nothing without steps', () => {
    const { container } = render(<PlanCard steps={[]} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('ToolActivity', () => {
  it('one compact row per tool call: what it did, what it found, how long; details open on click', () => {
    render(
      <ToolActivity
        tools={[
          { callId: '1', tool: 'kb.search', label: 'Searched AFS sources', status: 'done', summary: '12 cards', ms: 420 },
          { callId: '2', tool: 'web.search', label: 'Searching the literature', status: 'running' },
          { callId: '3', tool: 'calc.fiber_window', label: 'Checked the fiber window', status: 'failed', summary: 'no data' },
        ]}
      />,
    )
    const rows = within(screen.getByRole('list', { name: 'Tool activity' })).getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('Searched AFS sources · 12 cards0.4 s')
    expect(rows[1]).toHaveAttribute('data-status', 'running')
    expect(rows[2]).toHaveAttribute('data-status', 'failed')
    const head = within(rows[0]).getByRole('button')
    expect(head).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(head)
    expect(head).toHaveAttribute('aria-expanded', 'true')
    expect(within(rows[0]).getByText('kb.search')).toBeVisible()
  })

  it('renders nothing without tools', () => {
    const { container } = render(<ToolActivity tools={[]} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('AssistantMessage', () => {
  it('renders paragraphs, bold, bullets; cited card ids become chips that open the evidence', () => {
    const onCite = vi.fn()
    render(
      <AssistantMessage
        text={'**NIR fits** this product [S01-p17-nir].\n\n- Check a lab sample first.\n- Confirm the criteria.'}
        citations={{ 'S01-p17-nir': 'S01 p.17', 'S01-p10-range': 'S01 p.10' }}
        onCite={onCite}
      />,
    )
    expect(screen.getByText('NIR fits').tagName).toBe('STRONG')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    const chips = screen.getAllByRole('button', { name: /Show source/ })
    // the one named in the text sits in it; the cited-but-unnamed one is listed below
    expect(chips.map((c) => c.textContent)).toEqual(['S01 p.17', 'S01 p.10'])
    fireEvent.click(chips[0])
    expect(onCite).toHaveBeenCalledWith('S01-p17-nir')
    expect(screen.queryByText(/\[S01-p17-nir\]/)).toBeNull()
  })

  it('leaves brackets that are not citations alone, and hides the unnamed citations while streaming', () => {
    render(<AssistantMessage text="Range [780-2500 nm] holds." citations={{ 'S01-p10-range': 'S01 p.10' }} streaming />)
    expect(screen.getByText('Range [780-2500 nm] holds.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Show source/ })).toBeNull()
  })

  it('lists verified web sources', () => {
    render(<AssistantMessage text="See the paper." webSources={[{ url: 'https://doi.org/10.1/x', title: 'A paper', domain: 'doi.org' }]} />)
    expect(screen.getByRole('link', { name: /doi\.org/ })).toHaveAttribute('href', 'https://doi.org/10.1/x')
  })
})

describe('Suggestions', () => {
  it('a click hands the option, with its action and payload, to the caller', () => {
    const onPick = vi.fn()
    const options = [
      { label: 'Draft client e-mail', action: 'draft_email' },
      { label: 'Compare NIR vs Raman', action: 'compare', payload: { a: 'NIR', b: 'Raman' } },
    ]
    render(<Suggestions options={options} onPick={onPick} />)
    fireEvent.click(screen.getByRole('button', { name: /Compare NIR vs Raman/ }))
    expect(onPick).toHaveBeenCalledWith(options[1])
  })

  it('renders nothing without options; disabled while something is sending', () => {
    const { container, rerender } = render(<Suggestions options={[]} onPick={() => {}} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<Suggestions options={[{ label: 'Go', action: 'ask' }]} onPick={() => {}} disabled />)
    expect(screen.getByRole('button', { name: 'Go' })).toBeDisabled()
  })
})

// ---------------------------------------------------------------- Composer: Stop

function ComposerHarness({ running, onStop = () => {}, onSubmit = () => {} }: { running: boolean; onStop?: () => void; onSubmit?: (t: string) => void }) {
  const [value, setValue] = useState('next question')
  return (
    <Composer value={value} onChange={setValue} onSubmit={onSubmit} placeholder="Ask a follow-up question" deep={false} onDeepChange={() => {}} web={false} onWebChange={() => {}} docked running={running} onStop={onStop} />
  )
}

describe('Composer while a turn runs', () => {
  it('the send button becomes Stop and calls stop; Enter sends nothing', () => {
    const onStop = vi.fn()
    const onSubmit = vi.fn()
    render(<ComposerHarness running onStop={onStop} onSubmit={onSubmit} />)
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('Send is back once the turn is over', async () => {
    const onSubmit = vi.fn()
    const { rerender } = render(<ComposerHarness running onSubmit={onSubmit} />)
    rerender(<ComposerHarness running={false} onSubmit={onSubmit} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSubmit).toHaveBeenCalledWith('next question')
  })
})
