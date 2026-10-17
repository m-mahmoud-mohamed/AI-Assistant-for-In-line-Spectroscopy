// Pure projection of the run's SSE event stream onto the pipeline graph (docs/ARCHITECTURE.md §8).
// `applyEvent` is idempotent per `seq`, so a reconnect that replays stored events is harmless.
import { ALL_STAGES, type RunEvent, type RunEventType, type Severity, type Stage, type WebSourceEvent } from '../types'

export type NodeStatus = 'idle' | 'running' | 'done' | 'warning' | 'failed' | 'refused'
export type RunStatus = 'idle' | 'running' | 'completed' | 'refused' | 'failed'

export interface FiredRule {
  rule_id: string
  severity: Severity | string
  message: string
}

export interface Issue {
  check_id: string
  path: string
  message: string
  severity: string
}

export interface StageState {
  stage: Stage
  status: NodeStatus
  /** From `stage_completed.payload.seconds`; null until the stage completes. */
  seconds: number | null
  events: RunEvent[]
  rules: FiredRule[]
  issues: Issue[]
  /** Issues found since the stage last started (a re-run after repair can come back clean). */
  passIssues: number
  evidenceIds: string[]
  repaired: number
}

export interface PipelineState {
  runId: string | null
  status: RunStatus
  /** Highest `seq` applied; events with `seq <= lastSeq` are replays and are ignored. */
  lastSeq: number
  stages: Record<Stage, StageState>
  /** Sources a web run looked at (`web_source` events), in arrival order, one per URL. */
  webSources: WebSourceEvent[]
  /** Events that could not be attributed to a stage (e.g. `run_failed` before any stage ran). */
  runEvents: RunEvent[]
  decisionStatus: string | null
  /** Scope-guard refusal; `suggestions` is set when the event payload carries them. */
  refusal: { label: string; reason: string; suggestions?: string[] } | null
  error: string | null
}

const emptyStage = (stage: Stage): StageState => ({
  stage,
  status: 'idle',
  seconds: null,
  events: [],
  rules: [],
  issues: [],
  passIssues: 0,
  evidenceIds: [],
  repaired: 0,
})

export function initialPipelineState(runId: string | null = null): PipelineState {
  return {
    runId,
    status: 'idle',
    // The store numbers events from 0 (prism.store.Store.add_event), so nothing has been applied at -1.
    lastSeq: -1,
    stages: Object.fromEntries(ALL_STAGES.map((s) => [s, emptyStage(s)])) as Record<Stage, StageState>,
    webSources: [],
    runEvents: [],
    decisionStatus: null,
    refusal: null,
    error: null,
  }
}

/** Stage an event belongs to when the backend sends `stage: null`. */
const NATURAL_STAGE: Partial<Record<RunEventType, Stage>> = {
  rule_fired: 'rules',
  evidence_selected: 'retrieve',
  web_source: 'web',
  issue_found: 'verify',
  repaired: 'repair',
}

const isStage = (s: unknown): s is Stage => typeof s === 'string' && (ALL_STAGES as readonly string[]).includes(s)
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : v == null ? fallback : String(v))
const runningStages = (state: PipelineState) => ALL_STAGES.filter((s) => state.stages[s].status === 'running')

const finished = (st: StageState): NodeStatus => (st.passIssues > 0 ? 'warning' : 'done')

export function applyEvent(state: PipelineState, event: RunEvent): PipelineState {
  if (state.runId !== null && event.run_id !== state.runId) return state
  if (event.seq <= state.lastSeq) return state

  const payload = event.payload ?? {}
  const stage: Stage | null = isStage(event.stage)
    ? event.stage
    : (NATURAL_STAGE[event.type] ?? runningStages(state)[0] ?? null)

  const stages = { ...state.stages }
  const update = (s: Stage, fn: (st: StageState) => Partial<StageState>) => {
    stages[s] = { ...stages[s], ...fn(stages[s]) }
  }
  if (stage) update(stage, (st) => ({ events: [...st.events, event] }))

  const next: PipelineState = {
    ...state,
    runId: state.runId ?? event.run_id,
    lastSeq: event.seq,
    stages,
    runEvents: stage ? state.runEvents : [...state.runEvents, event],
    status: state.status === 'idle' ? 'running' : state.status,
  }

  switch (event.type) {
    case 'stage_started':
      if (stage) update(stage, () => ({ status: 'running', seconds: null, passIssues: 0 }))
      break

    case 'stage_completed':
      if (stage) {
        const seconds = typeof payload.seconds === 'number' ? payload.seconds : null
        update(stage, (st) => ({ status: finished(st), seconds }))
      }
      break

    case 'rule_fired':
      if (stage)
        update(stage, (st) => ({
          rules: [
            ...st.rules,
            { rule_id: str(payload.rule_id, '?'), severity: str(payload.severity, 'info'), message: str(payload.message) },
          ],
        }))
      break

    case 'evidence_selected':
      if (stage) {
        const ids = Array.isArray(payload.ids) ? payload.ids.map((id) => str(id)) : []
        update(stage, (st) => ({ evidenceIds: [...st.evidenceIds, ...ids.filter((id) => !st.evidenceIds.includes(id))] }))
      }
      break

    case 'web_source': {
      const url = str(payload.url)
      const source: WebSourceEvent = {
        url,
        title: str(payload.title, url),
        status: str(payload.status, 'UNVERIFIED') as WebSourceEvent['status'],
        domain: str(payload.domain),
        card_id: payload.card_id == null ? null : str(payload.card_id),
        reason: str(payload.reason),
      }
      // one entry per URL: a later event for the same URL (e.g. verification finished) replaces it
      const i = state.webSources.findIndex((w) => w.url === url)
      next.webSources = i < 0 ? [...state.webSources, source] : state.webSources.map((w, k) => (k === i ? source : w))
      break
    }

    case 'issue_found':
      if (stage)
        update(stage, (st) => ({
          issues: [
            ...st.issues,
            {
              check_id: str(payload.check_id, '?'),
              path: str(payload.path),
              message: str(payload.message),
              severity: str(payload.severity, 'warning'),
            },
          ],
          passIssues: st.passIssues + 1,
          // an issue reported after the stage completed still flags it
          status: st.status === 'done' ? 'warning' : st.status,
        }))
      break

    case 'repaired':
      if (stage) update(stage, (st) => ({ repaired: st.repaired + 1 }))
      break

    case 'run_completed':
      for (const s of runningStages(next)) update(s, (st) => ({ status: finished(st) }))
      next.status = 'completed'
      next.decisionStatus = payload.status == null ? null : str(payload.status)
      break

    case 'run_refused': {
      const target = stage ?? 'scope'
      update(target, () => ({ status: 'refused' }))
      for (const s of runningStages(next)) if (s !== target) update(s, () => ({ status: 'refused' }))
      next.status = 'refused'
      next.refusal = { label: str(payload.label, 'REFUSED'), reason: str(payload.reason) }
      if (Array.isArray(payload.suggestions)) next.refusal.suggestions = payload.suggestions.map((s) => str(s))
      break
    }

    case 'run_failed': {
      const targets = new Set<Stage>(runningStages(next))
      if (isStage(event.stage)) targets.add(event.stage)
      for (const s of targets) update(s, () => ({ status: 'failed' }))
      next.status = 'failed'
      next.error = str(payload.error ?? payload.message ?? payload.reason, 'Run failed')
      break
    }
  }
  return next
}

/** Fold a list of events (e.g. a stored trace) into a pipeline state. */
export const applyEvents = (events: readonly RunEvent[], init: PipelineState = initialPipelineState()): PipelineState =>
  events.reduce(applyEvent, init)

export const isTerminal = (status: RunStatus) => status === 'completed' || status === 'refused' || status === 'failed'

export const STAGE_LABELS: Record<Stage, string> = {
  scope: 'Scope',
  extract: 'Extract',
  normalise: 'Normalise',
  rules: 'Rules',
  retrieve: 'Retrieve',
  web: 'Web',
  draft: 'Draft',
  verify: 'Verify',
  repair: 'Repair',
  render: 'Render',
}
