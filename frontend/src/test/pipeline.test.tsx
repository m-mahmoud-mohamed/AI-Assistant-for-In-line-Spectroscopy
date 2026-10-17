import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { NodeDetail } from '../components/NodeDetail'
import { PipelineGraph } from '../components/PipelineGraph'
import { useRunEvents } from '../hooks/useRunEvents'
import { mockCompletedEvents, mockRefusedEvents } from '../mock/events'
import { applyEvent, applyEvents, initialPipelineState } from '../pipeline/reducer'
import { STAGES, type RunEvent, type RunEventType, type Stage } from '../types'

const RUN = 'run-test'
let seq = 0
const ev = (type: RunEventType, stage: Stage | null, payload: Record<string, unknown> = {}): RunEvent => ({
  type,
  run_id: RUN,
  seq: ++seq,
  ts: `2026-10-17T10:00:${String(seq).padStart(2, '0')}Z`,
  stage,
  payload,
})

/** One full run: every stage starts and completes; rules fire, evidence is selected, verify finds an issue. */
function fullSequence({ withIssue = true } = {}): RunEvent[] {
  seq = 0
  const out: RunEvent[] = []
  for (const [i, stage] of STAGES.entries()) {
    out.push(ev('stage_started', stage))
    if (stage === 'rules') {
      out.push(ev('rule_fired', 'rules', { rule_id: 'R01', severity: 'blocking', message: 'first rule' }))
      out.push(ev('rule_fired', 'rules', { rule_id: 'R02', severity: 'info', message: 'second rule' }))
    }
    if (stage === 'retrieve') out.push(ev('evidence_selected', 'retrieve', { ids: ['card-a', 'card-b'] }))
    if (stage === 'verify' && withIssue)
      out.push(ev('issue_found', 'verify', { check_id: 'P01', path: 'risks[0]', message: 'uncited number', severity: 'warning' }))
    if (stage === 'repair' && withIssue) out.push(ev('repaired', 'repair', { check_id: 'P01' }))
    out.push(ev('stage_completed', stage, { seconds: i + 0.5 }))
  }
  out.push(ev('run_completed', 'render', { status: 'PROVISIONAL' }))
  return out
}

describe('pipeline reducer', () => {
  it('starts with every stage idle', () => {
    const s = initialPipelineState(RUN)
    expect(s.status).toBe('idle')
    expect(STAGES.map((st) => s.stages[st].status)).toEqual(STAGES.map(() => 'idle'))
  })

  it('walks the full event sequence: idle → running → done with durations', () => {
    const events = fullSequence({ withIssue: false })
    let s = initialPipelineState(RUN)

    s = applyEvent(s, events[0])
    expect(s.status).toBe('running')
    expect(s.stages.scope.status).toBe('running')
    expect(s.stages.extract.status).toBe('idle')

    s = applyEvent(s, events[1])
    expect(s.stages.scope.status).toBe('done')
    expect(s.stages.scope.seconds).toBe(0.5)

    s = events.slice(2).reduce(applyEvent, s)
    expect(s.status).toBe('completed')
    expect(s.decisionStatus).toBe('PROVISIONAL')
    expect(STAGES.map((st) => s.stages[st].status)).toEqual(STAGES.map(() => 'done'))
    expect(STAGES.map((st) => s.stages[st].seconds)).toEqual(STAGES.map((_, i) => i + 0.5))
    expect(s.stages.rules.rules.map((r) => r.rule_id)).toEqual(['R01', 'R02'])
    expect(s.stages.retrieve.evidenceIds).toEqual(['card-a', 'card-b'])
    expect(s.stages.rules.events.map((e) => e.type)).toEqual(['stage_started', 'rule_fired', 'rule_fired', 'stage_completed'])
    expect(s.lastSeq).toBe(events.length)
  })

  it('issues turn the verify node into a warning', () => {
    const s = applyEvents(fullSequence())
    expect(s.stages.verify.status).toBe('warning')
    expect(s.stages.verify.issues).toEqual([
      { check_id: 'P01', path: 'risks[0]', message: 'uncited number', severity: 'warning' },
    ])
    expect(s.stages.repair.status).toBe('done')
    expect(s.stages.repair.repaired).toBe(1)
    expect(s.status).toBe('completed')
  })

  it('a refusal marks scope refused and leaves later stages idle', () => {
    seq = 0
    const events = [
      ev('stage_started', 'scope'),
      ev('run_refused', 'scope', { label: 'OFF_TOPIC', reason: 'not a measurement enquiry' }),
    ]
    const s = applyEvents(events)
    expect(s.status).toBe('refused')
    expect(s.stages.scope.status).toBe('refused')
    expect(s.refusal).toEqual({ label: 'OFF_TOPIC', reason: 'not a measurement enquiry' })
    expect(STAGES.slice(1).map((st) => s.stages[st].status)).toEqual(STAGES.slice(1).map(() => 'idle'))
  })

  it('a failed run marks the running stage failed', () => {
    seq = 0
    const s = applyEvents([ev('stage_started', 'scope'), ev('stage_completed', 'scope', { seconds: 1 }), ev('stage_started', 'extract'), ev('run_failed', null, { error: 'boom' })])
    expect(s.status).toBe('failed')
    expect(s.stages.scope.status).toBe('done')
    expect(s.stages.extract.status).toBe('failed')
  })

  it('run_completed settles a stage that never reported completion', () => {
    seq = 0
    const s = applyEvents([
      ev('stage_started', 'verify'),
      ev('issue_found', 'verify', { check_id: 'P02', path: 'x', message: 'm', severity: 'warning' }),
      ev('stage_started', 'render'),
      ev('run_completed', 'render', { status: 'INSUFFICIENT_INFORMATION' }),
    ])
    expect(s.stages.render.status).toBe('done')
    expect(s.stages.verify.status).toBe('warning')
    expect(s.decisionStatus).toBe('INSUFFICIENT_INFORMATION')
  })

  it('ignores replayed (duplicate) events and events of another run', () => {
    const events = fullSequence()
    const once = applyEvents(events)
    const twice = events.reduce(applyEvent, once)
    expect(twice).toBe(once)
    expect(applyEvent(once, { ...events[0], run_id: 'other', seq: 999 })).toBe(once)
  })

  it('attributes events without a stage to their natural stage', () => {
    seq = 0
    const s = applyEvents([ev('rule_fired', null, { rule_id: 'R09', severity: 'warning', message: 'm' })])
    expect(s.stages.rules.rules).toHaveLength(1)
  })

  it('the mock sequences replay cleanly', () => {
    const done = applyEvents(mockCompletedEvents('mock'))
    expect(done.status).toBe('completed')
    expect(done.stages.rules.rules.length).toBeGreaterThan(0)
    expect(done.stages.verify.status).toBe('warning')
    expect(applyEvents(mockRefusedEvents('mock')).status).toBe('refused')
  })
})

// ---------------------------------------------------------------- SSE hook

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly url: string
  readyState = 0
  onopen: ((e: Event) => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  closed = false
  private listeners = new Map<string, ((e: MessageEvent) => void)[]>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  removeEventListener() {}
  close() {
    this.closed = true
    this.readyState = 2
  }
  emit(event: RunEvent, named = false) {
    const msg = new MessageEvent(named ? event.type : 'message', { data: JSON.stringify(event) })
    if (named) this.listeners.get(event.type)?.forEach((fn) => fn(msg))
    else this.onmessage?.(msg)
  }
  fail() {
    this.readyState = 2
    this.onerror?.(new Event('error'))
  }
}

describe('useRunEvents', () => {
  it('streams events, survives a reconnect with replay, and closes on completion', () => {
    vi.useFakeTimers()
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    const events = fullSequence().map((e) => ({ ...e, run_id: 'r1' }))

    const { result, unmount } = renderHook(() => useRunEvents('r1'))
    expect(FakeEventSource.instances).toHaveLength(1)
    const first = FakeEventSource.instances[0]
    expect(first.url).toBe('/api/runs/r1/events')

    act(() => events.slice(0, 5).forEach((e) => first.emit(e)))
    expect(result.current.state.lastSeq).toBe(5)

    act(() => first.fail())
    expect(result.current.connection).toBe('reconnecting')
    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(FakeEventSource.instances).toHaveLength(2)
    const second = FakeEventSource.instances[1]

    // The server replays stored events from the start; named SSE events are handled too.
    act(() => events.forEach((e) => second.emit(e, true)))
    expect(result.current.state.status).toBe('completed')
    expect(result.current.state.stages.rules.rules).toHaveLength(2)
    expect(second.closed).toBe(true)
    expect(result.current.connection).toBe('closed')

    unmount()
    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------- components

describe('pipeline graph', () => {
  it('strip shows every stage with status label, duration and counts', () => {
    const state = applyEvents(fullSequence())
    const onSelect = vi.fn()
    render(<PipelineGraph state={state} variant="strip" onSelect={onSelect} />)
    const strip = screen.getByRole('list', { name: 'Pipeline stages' })
    const items = within(strip).getAllByRole('listitem')
    expect(items).toHaveLength(STAGES.length)
    expect(items[3]).toHaveTextContent('Rules')
    expect(items[3]).toHaveTextContent('Done')
    expect(items[3]).toHaveTextContent('2 rules')
    expect(items[6]).toHaveTextContent('Warning')
    expect(items[6]).toHaveTextContent('1 issue')
    expect(items[0]).toHaveTextContent('0.5 s')

    fireEvent.click(within(items[6]).getByRole('button'))
    expect(onSelect).toHaveBeenCalledWith('verify')
  })

  it('full graph renders nodes that list fired rules and issues', () => {
    const state = applyEvents(fullSequence())
    render(<PipelineGraph state={state} />)
    const graph = screen.getByRole('group', { name: 'Pipeline graph' })
    expect(within(graph).getByText('R01')).toBeInTheDocument()
    expect(within(graph).getByText('P01')).toBeInTheDocument()
    expect(within(graph).getByText('Normalise')).toBeInTheDocument()
  })

  it('an idle graph is still shown while waiting for events', () => {
    render(<PipelineGraph state={initialPipelineState('r1')} variant="strip" />)
    expect(within(screen.getByRole('list', { name: 'Pipeline stages' })).getAllByText('Idle')).toHaveLength(STAGES.length)
  })

  it('NodeDetail shows the stage events and payload JSON', () => {
    const state = applyEvents(fullSequence())
    const onClose = vi.fn()
    render(<NodeDetail stage="rules" state={state.stages.rules} onClose={onClose} />)
    const dialog = screen.getByRole('dialog', { name: 'Rules stage' })
    expect(within(dialog).getAllByText('rule_fired')).toHaveLength(2)
    expect(dialog).toHaveTextContent('"rule_id": "R01"')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close stage details' }))
    expect(onClose).toHaveBeenCalled()
  })
})
