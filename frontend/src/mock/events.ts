// Synthetic run traces for developing the pipeline graph without a backend.
// Rule and check IDs are placeholders, not real engine output.
import { STAGES, type RunEvent, type RunEventType, type Stage } from '../types'

function builder(runId: string) {
  let seq = 0
  const t0 = Date.parse('2026-01-01T00:00:00Z')
  return (type: RunEventType, stage: Stage | null, payload: Record<string, unknown> = {}): RunEvent => {
    seq += 1
    return { type, run_id: runId, seq, ts: (t0 + seq * 250) / 1000, stage, payload }
  }
}

const SECONDS: Record<Stage, number> = {
  scope: 0.2,
  extract: 3.1,
  normalise: 0.1,
  rules: 0.1,
  retrieve: 0.6,
  draft: 7.4,
  verify: 2.2,
  repair: 3.0,
  render: 0.1,
}

/** A complete run: rules fire, evidence is selected, verify finds issues that repair fixes. */
export function mockCompletedEvents(runId = 'mock-run'): RunEvent[] {
  const ev = builder(runId)
  const out: RunEvent[] = []
  for (const stage of STAGES) {
    out.push(ev('stage_started', stage))
    if (stage === 'rules') {
      out.push(ev('rule_fired', stage, { rule_id: 'MOCK-R1', severity: 'premise', message: 'Mock premise rule fired.' }))
      out.push(ev('rule_fired', stage, { rule_id: 'MOCK-R2', severity: 'warning', message: 'Mock warning rule fired.' }))
      out.push(ev('rule_fired', stage, { rule_id: 'MOCK-R3', severity: 'info', message: 'Mock info rule fired.' }))
    }
    if (stage === 'retrieve') out.push(ev('evidence_selected', stage, { ids: ['mock-card-1', 'mock-card-2', 'mock-card-3'] }))
    if (stage === 'verify') {
      out.push(
        ev('issue_found', stage, {
          check_id: 'MOCK-P1',
          path: 'recommendations[0].rationale[1]',
          message: 'Mock issue: segment has no evidence.',
          severity: 'warning',
        }),
      )
    }
    if (stage === 'repair') out.push(ev('repaired', stage, { check_id: 'MOCK-P1' }))
    out.push(ev('stage_completed', stage, { seconds: SECONDS[stage] }))
  }
  out.push(ev('run_completed', 'render', { status: 'PROVISIONAL' }))
  return out
}

/** A run the scope guard refuses before extraction. */
export function mockRefusedEvents(runId = 'mock-refused'): RunEvent[] {
  const ev = builder(runId)
  return [
    ev('stage_started', 'scope'),
    ev('run_refused', 'scope', { label: 'OFF_TOPIC', reason: 'Mock refusal: not a measurement enquiry.' }),
  ]
}
