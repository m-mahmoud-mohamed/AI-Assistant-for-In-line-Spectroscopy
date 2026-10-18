// Pure projection of an assistant turn's SSE event stream (CONTRACTS C4) onto what the conversation column renders:
// the streamed message, the plan checklist, tool activity, the pending question or approval, the verdict preview,
// the report run the turn started, and the suggested next steps. Idempotent per `seq`, so a reconnect that replays
// stored events is harmless.
import { parseEnginePreview } from '../pipeline/reducer'
import type { ChatWebSource, ClarifyQuestion, EnginePreview, PlanStep, QuestionAnswer, Suggestion, TurnEvent } from '../types'

export type TurnStatus = 'idle' | 'running' | 'completed' | 'failed' | 'stopped'

export interface ToolRun {
  callId: string
  tool: string
  label: string
  status: 'running' | 'done' | 'failed'
  summary?: string
}

export interface PendingQuestion {
  questionId: string
  title: string
  questions: ClarifyQuestion[]
  /** Answered (by this client, or by a later event of the replayed stream): the card shows its summary. */
  resolved: boolean
  /** What this client submitted; absent when the answer came from elsewhere (a replay). */
  answers?: Record<string, QuestionAnswer>
}

export interface PendingApproval {
  approvalId: string
  action: string
  label: string
  why: string
  costCalls: number | null
  resolved: boolean
  decision?: 'approved' | 'declined'
}

/** What happened in a turn, in the order it happened. The plan and the verdict are separate (one card each, updated in place). */
export type TurnItem =
  | { kind: 'text'; id: string; text: string }
  | { kind: 'tool'; id: string; tool: ToolRun }
  | { kind: 'question'; id: string; question: PendingQuestion }
  | { kind: 'approval'; id: string; approval: PendingApproval }

export interface StepTiming {
  /** Seconds since the epoch of the event that made the step active. */
  start: number | null
}

export interface TurnState {
  turnId: string | null
  /** Highest `seq` applied; events with `seq <= lastSeq` are replays and are ignored. */
  lastSeq: number
  status: TurnStatus
  items: TurnItem[]
  plan: PlanStep[]
  planTimes: Record<string, StepTiming>
  verdict: EnginePreview | null
  /** The report run this turn started (the UI attaches the report pane to it). */
  report: { runId: string; version: number | null } | null
  suggestions: Suggestion[]
  /** Final message (`turn_completed`), citation labels by card id, and verified web sources it cites. */
  message: string | null
  citations: Record<string, string>
  webSources: ChatWebSource[]
  error: string | null
}

export type TurnAction =
  | { kind: 'reset'; turnId: string | null; events?: readonly TurnEvent[] }
  | { kind: 'event'; event: TurnEvent }
  | { kind: 'stopped' }
  | { kind: 'answered'; questionId: string; answers: Record<string, QuestionAnswer> }
  | { kind: 'decided'; approvalId: string; approved: boolean }

/** `started`: the turn exists on the server and has not spoken yet (it is working, so the UI shows it running). */
export function initialTurnState(turnId: string | null = null, started = false): TurnState {
  return {
    turnId,
    lastSeq: -1,
    status: started ? 'running' : 'idle',
    items: [],
    plan: [],
    planTimes: {},
    verdict: null,
    report: null,
    suggestions: [],
    message: null,
    citations: {},
    webSources: [],
    error: null,
  }
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : v == null ? fallback : String(v))
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
export const isTurnTerminal = (status: TurnStatus) => status === 'completed' || status === 'failed' || status === 'stopped'

const PLAN_STATUSES: readonly PlanStep['status'][] = ['pending', 'active', 'done', 'skipped']

function parsePlan(payload: Record<string, unknown>): PlanStep[] {
  const steps = Array.isArray(payload.steps) ? payload.steps : []
  return steps.filter(isRecord).map((s, i) => {
    const status = PLAN_STATUSES.includes(s.status as PlanStep['status']) ? (s.status as PlanStep['status']) : 'pending'
    return { id: str(s.id, String(i)), label: str(s.label), status, ...(s.detail != null ? { detail: str(s.detail) } : {}) }
  })
}

/** Mark every open question / approval as answered (something that only happens after the answer has arrived). */
function resolveOpen(items: TurnItem[]): TurnItem[] {
  if (!items.some((i) => (i.kind === 'question' && !i.question.resolved) || (i.kind === 'approval' && !i.approval.resolved))) return items
  return items.map((i) => {
    if (i.kind === 'question' && !i.question.resolved) return { ...i, question: { ...i.question, resolved: true } }
    if (i.kind === 'approval' && !i.approval.resolved) return { ...i, approval: { ...i.approval, resolved: true } }
    return i
  })
}

const upsertTool = (items: TurnItem[], tool: ToolRun): TurnItem[] => {
  const i = items.findIndex((it) => it.kind === 'tool' && it.tool.callId === tool.callId)
  if (i < 0) return [...items, { kind: 'tool', id: `tool-${tool.callId}`, tool: { ...tool, label: tool.label || tool.tool } }]
  const prev = items[i] as Extract<TurnItem, { kind: 'tool' }>
  return items.map((it, k) => (k === i ? { ...prev, tool: { ...prev.tool, ...tool, label: tool.label || prev.tool.label } } : it))
}

function trackPlanTimes(prev: Record<string, StepTiming>, steps: PlanStep[], ts: number): Record<string, StepTiming> {
  const out = { ...prev }
  for (const s of steps) {
    const t = out[s.id] ?? { start: null }
    if (s.status === 'active' && t.start === null) out[s.id] = { start: ts }
    else if (!(s.id in out)) out[s.id] = t
  }
  return out
}

export function applyTurnEvent(state: TurnState, event: TurnEvent): TurnState {
  if (state.turnId !== null && event.turn_id !== state.turnId) return state
  if (event.seq <= state.lastSeq) return state
  const payload = isRecord(event.payload) ? event.payload : {}
  const base: TurnState = {
    ...state,
    turnId: state.turnId ?? event.turn_id,
    lastSeq: event.seq,
    status: state.status === 'idle' ? 'running' : state.status,
  }

  switch (event.type) {
    case 'message_delta': {
      const text = str(payload.text)
      if (!text) return base
      const last = base.items[base.items.length - 1]
      if (last?.kind === 'text') {
        return { ...base, items: [...base.items.slice(0, -1), { ...last, text: last.text + text }] }
      }
      return { ...base, items: [...base.items, { kind: 'text', id: `text-${event.seq}`, text }] }
    }

    case 'plan': {
      const plan = parsePlan(payload)
      return { ...base, plan, planTimes: trackPlanTimes(state.planTimes, plan, event.ts) }
    }

    case 'tool_started':
      return {
        ...base,
        items: upsertTool(resolveOpen(base.items), {
          callId: str(payload.call_id, `call-${event.seq}`),
          tool: str(payload.tool),
          label: str(payload.label, str(payload.tool)),
          status: 'running',
        }),
      }

    case 'tool_finished':
      return {
        ...base,
        items: upsertTool(resolveOpen(base.items), {
          callId: str(payload.call_id, `call-${event.seq}`),
          tool: str(payload.tool),
          label: '',
          status: payload.ok === false ? 'failed' : 'done',
          summary: payload.summary == null ? undefined : str(payload.summary),
        }),
      }

    case 'question': {
      const questions = (Array.isArray(payload.questions) ? payload.questions : []) as ClarifyQuestion[]
      const question: PendingQuestion = {
        questionId: str(payload.question_id, `q-${event.seq}`),
        title: str(payload.title),
        questions,
        resolved: false,
      }
      return { ...base, items: [...resolveOpen(base.items), { kind: 'question', id: `question-${question.questionId}`, question }] }
    }

    case 'approval': {
      const approval: PendingApproval = {
        approvalId: str(payload.approval_id, `a-${event.seq}`),
        action: str(payload.action),
        label: str(payload.label, str(payload.action)),
        why: str(payload.why),
        costCalls: typeof payload.cost_calls === 'number' ? payload.cost_calls : null,
        resolved: false,
      }
      return { ...base, items: [...resolveOpen(base.items), { kind: 'approval', id: `approval-${approval.approvalId}`, approval }] }
    }

    case 'verdict':
      return { ...base, items: resolveOpen(base.items), verdict: parseEnginePreview(payload) }

    case 'report': {
      const runId = str(payload.run_id)
      if (!runId) return base
      return {
        ...base,
        items: resolveOpen(base.items),
        report: { runId, version: typeof payload.version === 'number' ? payload.version : null },
      }
    }

    case 'suggestions': {
      const options = (Array.isArray(payload.options) ? payload.options : []).filter(isRecord)
      return {
        ...base,
        items: resolveOpen(base.items),
        suggestions: options.map((o) => ({ label: str(o.label), action: str(o.action), payload: o.payload })),
      }
    }

    case 'turn_completed': {
      const message = payload.message == null ? null : str(payload.message)
      let items = resolveOpen(base.items)
      if (message) {
        const lastText = items.map((i) => i.kind).lastIndexOf('text')
        items =
          lastText >= 0
            ? items.map((it, k) => (k === lastText && it.kind === 'text' ? { ...it, text: message } : it))
            : [...items, { kind: 'text', id: `text-${event.seq}`, text: message }]
      }
      const citations: Record<string, string> = {}
      if (isRecord(payload.citations)) for (const [id, label] of Object.entries(payload.citations)) citations[id] = str(label, id)
      const webSources = (Array.isArray(payload.web_sources) ? payload.web_sources : []).filter(isRecord) as unknown as ChatWebSource[]
      return { ...base, status: 'completed', items, message, citations, webSources, plan: finishPlan(base.plan) }
    }

    case 'turn_failed':
      return { ...base, status: 'failed', items: resolveOpen(base.items), error: str(payload.error, 'The turn failed.') }
  }
  return base
}

/** A completed turn has no step left active (a backend that forgets the last plan update would leave a spinner). */
const finishPlan = (plan: PlanStep[]): PlanStep[] => plan.map((s) => (s.status === 'active' ? { ...s, status: 'done' } : s))

export function turnReducer(state: TurnState, action: TurnAction): TurnState {
  switch (action.kind) {
    case 'reset':
      return (action.events ?? []).reduce(applyTurnEvent, initialTurnState(action.turnId, action.turnId !== null))
    case 'event':
      return applyTurnEvent(state, action.event)
    case 'stopped':
      return isTurnTerminal(state.status)
        ? state
        : { ...state, status: 'stopped', items: resolveOpen(state.items), plan: state.plan.map((s) => (s.status === 'active' ? { ...s, status: 'pending' } : s)) }
    case 'answered':
      return {
        ...state,
        items: state.items.map((it) =>
          it.kind === 'question' && it.question.questionId === action.questionId
            ? { ...it, question: { ...it.question, resolved: true, answers: action.answers } }
            : it,
        ),
      }
    case 'decided':
      return {
        ...state,
        items: state.items.map((it) =>
          it.kind === 'approval' && it.approval.approvalId === action.approvalId
            ? { ...it, approval: { ...it.approval, resolved: true, decision: action.approved ? 'approved' : 'declined' } }
            : it,
        ),
      }
  }
}

// ---------------------------------------------------------------- selectors

/** The question the turn is waiting on, if any. */
export const openQuestion = (s: TurnState): PendingQuestion | null => {
  if (isTurnTerminal(s.status)) return null
  for (let i = s.items.length - 1; i >= 0; i--) {
    const it = s.items[i]
    if (it.kind === 'question' && !it.question.resolved) return it.question
  }
  return null
}

/** The approval the turn is waiting on, if any. */
export const openApproval = (s: TurnState): PendingApproval | null => {
  if (isTurnTerminal(s.status)) return null
  for (let i = s.items.length - 1; i >= 0; i--) {
    const it = s.items[i]
    if (it.kind === 'approval' && !it.approval.resolved) return it.approval
  }
  return null
}

/** The turn is running (not finished): the composer shows Stop instead of Send. */
export const isTurnRunning = (s: TurnState) => s.status === 'running'

/** The turn is paused on a question or an approval. */
export const isTurnWaiting = (s: TurnState) => isTurnRunning(s) && (openQuestion(s) !== null || openApproval(s) !== null)
