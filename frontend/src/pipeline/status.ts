// Visual vocabulary for pipeline node states: every state has an icon, a text label and a colour.
import { Ban, Circle, CircleCheck, CircleX, LoaderCircle, TriangleAlert, type LucideIcon } from 'lucide-react'
import { ALL_STAGES, OPTIONAL_STAGES, type Stage } from '../types'
import type { NodeStatus, PipelineState, StageState } from './reducer'

export const NODE_STATUS: Record<NodeStatus, { label: string; icon: LucideIcon; color: string }> = {
  idle: { label: 'Idle', icon: Circle, color: 'var(--text-muted)' },
  running: { label: 'Running', icon: LoaderCircle, color: 'var(--fiber-cyan)' },
  done: { label: 'Done', icon: CircleCheck, color: 'var(--status-ok)' },
  warning: { label: 'Warning', icon: TriangleAlert, color: 'var(--status-warn)' },
  failed: { label: 'Failed', icon: CircleX, color: 'var(--status-bad)' },
  refused: { label: 'Refused', icon: Ban, color: 'var(--fiber-magenta)' },
}

export const formatSeconds = (s: number | null): string | null =>
  s === null ? null : s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Short findings summary for a node, e.g. "2 rules", "1 issue", "3 cards". */
export function stageCounts(st: StageState): string[] {
  const out: string[] = []
  if (st.rules.length) out.push(plural(st.rules.length, 'rule'))
  if (st.issues.length) out.push(plural(st.issues.length, 'issue'))
  if (st.evidenceIds.length) out.push(plural(st.evidenceIds.length, 'card'))
  if (st.repaired) out.push(`${st.repaired} repaired`)
  return out
}

/** The stages this run shows: the required ones always, an optional one (`web`) only once the run emitted it. */
export function stagesRun(state: PipelineState): Stage[] {
  return ALL_STAGES.filter((s) => {
    if (!(OPTIONAL_STAGES as readonly Stage[]).includes(s)) return true
    const st = state.stages[s]
    return st.status !== 'idle' || st.events.length > 0 || (s === 'web' && state.webSources.length > 0)
  })
}

/** Total of the stages' reported seconds, or null while none has finished. */
export function totalSeconds(state: PipelineState): number | null {
  const done = ALL_STAGES.map((s) => state.stages[s].seconds).filter((s): s is number => s !== null)
  return done.length ? done.reduce((a, b) => a + b, 0) : null
}
