import { describe, expect, it } from 'vitest'
import type { TurnState } from '../assistant/turnReducer'
import { flatSteps, turnSteps, withRun } from '../components/assistant/progressSteps'
import type { TurnEvent } from '../types'

const ev = (type: string, ts: number, payload: Record<string, unknown> = {}) =>
  ({ type, ts, seq: ts, turn_id: 't', payload }) as unknown as TurnEvent

const state = {
  plan: [
    { id: 'understand', label: 'Understand the enquiry', status: 'done' },
    { id: 'write', label: 'Write the assessment', status: 'active' },
  ],
  planTimes: { understand: { start: 1, seconds: 2 }, write: { start: 10, seconds: null } },
  items: [
    { kind: 'tool', tool: { callId: 'c1', tool: 'assess.prepare', label: 'Reading the enquiry', status: 'done', ms: 2000 } },
    { kind: 'tool', tool: { callId: 'c2', tool: 'mcp.lab.query', label: 'Running query on lab', status: 'running', ms: null } },
  ],
} as unknown as TurnState
const events = [ev('tool_started', 2, { call_id: 'c1' }), ev('tool_started', 11, { call_id: 'c2' })]

describe('progress steps', () => {
  it('nests each tool call under the plan step that had started, so nothing is listed twice', () => {
    const steps = turnSteps(state, events)
    expect(steps.map((s) => s.label)).toEqual(['Understand the enquiry', 'Write the assessment'])
    expect(steps[0].children?.map((s) => s.label)).toEqual(['Reading the enquiry'])
    expect(steps[1].children?.map((s) => s.tool)).toEqual(['mcp.lab.query'])
  })

  it('puts the report run under the writing step and finds the most specific live step', () => {
    const run = [{ id: 'run-verify', label: 'Verifying claims', status: 'running', seconds: null, at: 12 }]
    const steps = withRun(turnSteps(state, events), run)
    expect(steps[1].children?.map((s) => s.label)).toEqual(['Running query on lab', 'Verifying claims'])
    expect(flatSteps(steps).map((s) => s.id)).toEqual(['plan-understand', 'c1', 'plan-write', 'c2', 'run-verify'])
  })

  it('without a plan, tool calls stay top level', () => {
    const plain = { ...state, plan: [], planTimes: {} } as unknown as TurnState
    expect(turnSteps(plain, events).map((s) => s.id)).toEqual(['c1', 'c2'])
  })
})

describe('stored answers', () => {
  it('get citation labels from the report sources and from knowledge-base card ids', async () => {
    const { storedCitations } = await import('../components/thread/sources')
    const text = '**NIR** fits [S01-p05-nir-penetration] [TABLE-nir_surface_at_a_distance] [S02-p13-x] [not a card]'
    expect(storedCitations(text, [{ id: 'S02-p13-x', citation: 'S02 p.13 (slides)' }])).toEqual({
      'S01-p05-nir-penetration': 'S01 p.5', 'TABLE-nir_surface_at_a_distance': 'S01 Table 1', 'S02-p13-x': 'S02 p.13 (slides)',
    })
  })
})
