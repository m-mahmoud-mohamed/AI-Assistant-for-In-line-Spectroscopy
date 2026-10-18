import type { TurnState } from '../../assistant/turnReducer'
import type { PipelineState } from '../../pipeline/reducer'
import { stageCounts } from '../../pipeline/status'
import type { Stage, TurnEvent } from '../../types'

export interface ProgressStep {
  id: string
  label: string
  status: string
  seconds: number | null
  summary?: string
  tool?: string
  at?: number
  /** Tool calls and run stages that happened inside this plan step. */
  children?: ProgressStep[]
}

const STAGES: Record<Stage, string> = {
  scope: 'Reading the enquiry', extract: 'Reading the enquiry', normalise: 'Organizing requirements',
  rules: 'Analyzing evidence', retrieve: 'Searching sources', web: 'Searching sources',
  write: 'Writing the report', draft: 'Writing the report', verify: 'Verifying claims',
  patch: 'Refining the report', repair: 'Refining the report', render: 'Preparing the report',
}

/** Only stages that emitted events appear; planned future work is never presented as completed work. */
export function runSteps(state: PipelineState): ProgressStep[] {
  return Object.values(state.stages).filter((s) => s.events.length > 0 || s.status !== 'idle').map((s) => ({
    id: `run-${s.stage}`, label: STAGES[s.stage], status: s.status,
    seconds: s.seconds, at: s.events[0]?.ts,
    summary: [s.events.findLast((e) => typeof e.payload.summary === 'string')?.payload.summary, ...stageCounts(s)].filter(Boolean).join(' · '),
  })).sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
}

export function turnSteps(state: TurnState, events: readonly TurnEvent[] = []): ProgressStep[] {
  return nest([
    ...state.plan.map((s) => {
      const timing = state.planTimes[s.id]
      const end = events.findLast((e) => e.type === 'turn_completed' || e.type === 'turn_failed')?.ts
      return { id: `plan-${s.id}`, label: s.label, status: s.status, summary: s.detail,
        seconds: timing?.seconds ?? (timing?.start != null && end != null ? Math.max(0, end - timing.start) : null), at: timing?.start ?? undefined }
    }),
    ...state.items.flatMap((item) => {
      if (item.kind !== 'tool') return []
      const t = item.tool
      return [{ id: t.callId, label: t.label, status: t.status, summary: t.summary, tool: t.tool,
        seconds: t.ms == null ? null : t.ms / 1000,
        at: events.find((e) => e.type === 'tool_started' && e.payload.call_id === t.callId)?.ts }]
    }),
  ])
}

/** With a plan, each tool call sits under the plan step that had started when the call started; without one (or
 *  before any step started) it stays top level. */
function nest(steps: ProgressStep[]): ProgressStep[] {
  const plan = steps.filter((s) => s.id.startsWith('plan-')).map((s) => ({ ...s, children: [] as ProgressStep[] }))
  const started = plan.filter((s) => s.at != null).sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
  const top: ProgressStep[] = [...plan]
  for (const step of steps.filter((s) => !s.id.startsWith('plan-'))) {
    const owner = step.at == null ? undefined : started.findLast((p) => (p.at ?? 0) <= (step.at ?? 0))
    if (owner) owner.children.push(step)
    else top.push(step)
  }
  return top.map((s) => (s.children?.length ? s : { ...s, children: undefined }))
}

/** The report run's stages belong to the plan's writing step when the turn has one. */
export function withRun(steps: ProgressStep[], run: ProgressStep[]): ProgressStep[] {
  if (!run.length) return steps
  const write = steps.find((s) => s.id === 'plan-write')
  if (!write) return [...steps, ...run]
  return steps.map((s) => (s === write ? { ...s, children: [...(s.children ?? []), ...run] } : s))
}

/** Every step with its nested ones, in order (the live line shows the most specific running step). */
export function flatSteps(steps: ProgressStep[]): ProgressStep[] {
  return steps.flatMap((s) => [s, ...flatSteps(s.children ?? [])])
}

export function runDuration(state: PipelineState): number | null {
  const events = [...state.runEvents, ...Object.values(state.stages).flatMap((s) => s.events)]
  if (!events.length) return null
  return Math.max(0, Math.max(...events.map((e) => e.ts)) - Math.min(...events.map((e) => e.ts)))
}
