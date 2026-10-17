import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, CircleAlert, Loader2, Send, User, Wrench } from 'lucide-react'
import { api, isOffline } from '../api'
import { useRunEvents } from '../hooks/useRunEvents'
import { STAGE_LABELS } from '../pipeline/reducer'
import { reportSuggestions } from '../suggestions'
import type { ChatMessage, ChatResponse } from '../types'
import { DiffView } from './DiffView'
import { RefusalCard } from './RefusalCard'
import type { ReportViewData } from './report/ReportView'
import { SuggestionChips } from './SuggestionChips'

type AnswerResponse = Extract<ChatResponse, { kind: 'answer' }>

type Turn =
  | { id: string; kind: 'history'; message: ChatMessage }
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'answer'; answer: AnswerResponse; offline?: boolean }
  | { id: string; kind: 'run'; runId: string; expected: number }
  | { id: string; kind: 'refused'; reason: string; suggestions: string[] }
  | { id: string; kind: 'error'; text: string }

interface ChatPanelProps {
  sessionId: string | null
  /** Current report: source of citation labels and suggestion chips. */
  report?: ReportViewData
  /** Card ID → display citation (e.g. `S02 p.6`). */
  citations?: Record<string, string>
  onCite?: (cardId: string) => void
  onRunStarted?: (runId: string) => void
  onRunCompleted?: (runId: string) => void
  /** Controlled input (lets report-level suggestion chips fill it). */
  value?: string
  onValueChange?: (text: string) => void
  /** Report version currently shown, used when the session lists no versions (default 1). */
  version?: number
}

const OFFLINE_ANSWER: AnswerResponse = {
  kind: 'answer',
  text: 'Backend offline: this message was not sent. Start the API (make api) to ask about the report or add client information.',
  cited_ids: [],
  tool_calls: [],
  proposed_facts: [],
}

const factText = (f: string | { text: string }) => (typeof f === 'string' ? f : f.text)

let turnSeq = 0
const nextId = () => `turn-${++turnSeq}`

// ---------------------------------------------------------------- run turn

interface RunTurnProps {
  sessionId: string
  runId: string
  /** Expected version number while the run streams (the stored `reports[]` decide once it is done). */
  expected: number
  onCompleted?: (runId: string) => void
  onExample: (text: string) => void
}

/**
 * A chat message that started a new run: streams its events, then reloads the session detail and shows
 * the diff between the run's report version and the one before it (both taken from `reports[]`).
 */
function RunTurn({ sessionId, runId, expected, onCompleted, onExample }: RunTurnProps) {
  const { state, connection } = useRunEvents(runId)
  const done = state.status === 'completed'
  const queryClient = useQueryClient()
  const session = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => api.getSession(sessionId),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })

  // The run's version only appears in `reports[]` once it is stored: refetch the detail on completion.
  useEffect(() => {
    if (done) void queryClient.invalidateQueries({ queryKey: ['session', sessionId] })
  }, [done, queryClient, sessionId])

  const reports = session.data?.reports ?? []
  const to = reports.find((r) => r.run_id === runId)?.version ?? null
  const from = to === null ? null : reports.reduce<number | null>((b, r) => (r.version < to && (b === null || r.version > b) ? r.version : b), null)
  const diff = useQuery({
    queryKey: ['diff', sessionId, from, to],
    queryFn: () => api.getDiff(sessionId, from!, to!),
    enabled: done && from !== null && to !== null,
    retry: false,
  })

  const completedRef = useRef(onCompleted)
  useEffect(() => {
    completedRef.current = onCompleted
  }, [onCompleted])
  useEffect(() => {
    if (done) completedRef.current?.(runId)
  }, [done, runId])

  if (state.status === 'refused') {
    return (
      <RefusalCard
        reason={state.refusal?.reason ?? ''}
        label={state.refusal?.label}
        suggestions={state.refusal?.suggestions}
        onExample={onExample}
      />
    )
  }
  if (state.status === 'failed') {
    return (
      <p role="alert" className="flex items-center gap-2 text-sm" style={{ color: 'var(--status-bad)' }}>
        <CircleAlert size={14} aria-hidden="true" /> Run v{to ?? expected} failed: {state.error}
      </p>
    )
  }
  if (!done) {
    const running = Object.entries(state.stages).find(([, s]) => s.status === 'running')?.[0] as
      | keyof typeof STAGE_LABELS
      | undefined
    return (
      <div className="flex flex-col gap-1 text-sm" aria-live="polite">
        <p className="flex items-center gap-2">
          <Loader2 size={14} aria-hidden="true" className="animate-spin text-fiber-cyan" />
          <span>New version v{expected} running…</span>
        </p>
        {running && <p className="text-xs text-muted">Stage: {STAGE_LABELS[running]}</p>}
        {connection === 'error' && <p className="text-xs text-muted">Lost the connection to the run.</p>}
      </div>
    )
  }
  if (to === null) {
    return session.isFetching || session.isPending ? (
      <p className="text-sm text-muted">Run finished. Loading the new version…</p>
    ) : (
      <p className="text-sm text-muted">Run finished, but its report is not listed in this session.</p>
    )
  }
  if (from === null) return <p className="text-sm text-muted">Version v{to} ready (no earlier version to compare).</p>
  if (diff.isPending) return <p className="text-sm text-muted">Version v{to} ready. Loading changes…</p>
  if (diff.isError || !diff.data) return <p className="text-sm text-muted">Version v{to} ready. The changes could not be loaded.</p>
  return <DiffView diff={diff.data} from={from} to={to} />
}

// ---------------------------------------------------------------- panel

/** Chat with the assistant about the current session (`POST /api/sessions/{id}/messages`). */
export function ChatPanel({
  sessionId,
  report,
  citations = {},
  onCite,
  onRunStarted,
  onRunCompleted,
  value,
  onValueChange,
  version,
}: ChatPanelProps) {
  const inputId = useId()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const [localInput, setLocalInput] = useState('')
  const input = value ?? localInput
  const setInput = (text: string) => {
    if (onValueChange) onValueChange(text)
    else setLocalInput(text)
  }
  const fill = (text: string) => {
    setInput(text)
    inputRef.current?.focus()
  }

  // Local turns per session, so switching sessions keeps each history.
  const [turnsBySession, setTurnsBySession] = useState<Record<string, Turn[]>>({})
  const [sending, setSending] = useState(false)

  const session = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => api.getSession(sessionId!),
    enabled: !!sessionId,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })

  const history: Turn[] = (session.data?.messages ?? []).map((m) => ({ id: `h-${m.id}`, kind: 'history', message: m }))
  const turns = [...history, ...(sessionId ? (turnsBySession[sessionId] ?? []) : [])]

  const versions = session.data?.reports?.map((r) => r.version) ?? []
  const baseVersion = versions.length ? Math.max(...versions) : (version ?? 1)

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns.length])

  const push = (sid: string, ...add: Turn[]) =>
    setTurnsBySession((all) => ({ ...all, [sid]: [...(all[sid] ?? []), ...add] }))

  const send = async () => {
    const text = input.trim()
    if (!sessionId || !text || sending) return
    const sid = sessionId
    push(sid, { id: nextId(), kind: 'user', text })
    setInput('')
    setSending(true)
    try {
      const res = await api.postMessage(sid, text)
      if (res.kind === 'run') {
        // Runs started here that are not stored yet come before this one.
        const stored = new Set(session.data?.reports?.map((r) => r.run_id) ?? [])
        const pending = (turnsBySession[sid] ?? []).filter((t) => t.kind === 'run' && !stored.has(t.runId)).length
        const expected = baseVersion + pending + 1
        push(sid, { id: nextId(), kind: 'run', runId: res.run_id, expected })
        onRunStarted?.(res.run_id)
      } else if (res.kind === 'refused') {
        push(sid, { id: nextId(), kind: 'refused', reason: res.reason, suggestions: res.suggestions ?? [] })
      } else {
        push(sid, { id: nextId(), kind: 'answer', answer: res })
      }
    } catch (err) {
      if (isOffline(err)) push(sid, { id: nextId(), kind: 'answer', answer: OFFLINE_ANSWER, offline: true })
      else push(sid, { id: nextId(), kind: 'error', text: err instanceof Error ? err.message : 'Message failed.' })
    } finally {
      setSending(false)
    }
  }

  const suggestions = reportSuggestions(report)

  if (!sessionId) {
    return <p className="text-sm text-muted">Open a session or start an enquiry to chat about its report.</p>
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div
        ref={logRef}
        role="log"
        aria-label="Chat history"
        aria-live="polite"
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto"
      >
        {session.isPending && <p className="text-xs text-muted">Loading history…</p>}
        {turns.length === 0 && !session.isPending && (
          <p className="text-sm text-muted">Answer a clarification question or add client information to start a new version.</p>
        )}
        {turns.map((t) => {
          switch (t.kind) {
            case 'history':
              return t.message.role === 'user' ? (
                <UserBubble key={t.id} text={t.message.text} />
              ) : (
                <AssistantBubble key={t.id}>
                  <p className="whitespace-pre-wrap text-sm">{t.message.text}</p>
                </AssistantBubble>
              )
            case 'user':
              return <UserBubble key={t.id} text={t.text} />
            case 'answer':
              return (
                <AssistantBubble key={t.id}>
                  <p className={`whitespace-pre-wrap text-sm ${t.offline ? 'text-muted' : ''}`}>{t.answer.text}</p>
                  {t.answer.cited_ids.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {t.answer.cited_ids.map((id) => {
                        const label = citations[id] ?? id
                        return (
                          <button
                            key={id}
                            type="button"
                            onClick={() => onCite?.(id)}
                            aria-label={`Show source ${label}`}
                            className="rounded px-1 font-mono text-xs text-[var(--link)] underline decoration-dotted underline-offset-2 hover:bg-surface-raised"
                          >
                            [{label}]
                          </button>
                        )
                      })}
                    </div>
                  )}
                  {t.answer.tool_calls.length > 0 && (
                    <p className="flex flex-wrap items-center gap-1 text-[11px] text-muted">
                      <Wrench size={11} aria-hidden="true" /> Tools used:
                      {t.answer.tool_calls.map((c, i) => (
                        <span key={i} className="rounded border border-line px-1 font-mono">
                          {c.name}
                        </span>
                      ))}
                    </p>
                  )}
                  {t.answer.proposed_facts.length > 0 && (
                    <div className="flex flex-col gap-1 text-xs">
                      <span className="text-muted">Possible client facts (send to confirm and start a new version):</span>
                      {t.answer.proposed_facts.map((f, i) => (
                        <button
                          key={i}
                          type="button"
                          onClick={() => fill(factText(f))}
                          className="rounded border border-dashed border-line px-2 py-1 text-left hover:border-prism-500"
                        >
                          {factText(f)}
                        </button>
                      ))}
                    </div>
                  )}
                  {!t.offline && <SuggestionChips suggestions={suggestions} onPick={fill} />}
                </AssistantBubble>
              )
            case 'run':
              return (
                <AssistantBubble key={t.id}>
                  <RunTurn
                    sessionId={sessionId}
                    runId={t.runId}
                    expected={t.expected}
                    onCompleted={onRunCompleted}
                    onExample={fill}
                  />
                </AssistantBubble>
              )
            case 'refused':
              return <RefusalCard key={t.id} reason={t.reason} suggestions={t.suggestions} onExample={fill} />
            case 'error':
              return (
                <p key={t.id} role="alert" className="text-sm" style={{ color: 'var(--status-bad)' }}>
                  {t.text}
                </p>
              )
          }
        })}
      </div>

      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          Message
        </label>
        <textarea
          id={inputId}
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          rows={2}
          placeholder="Ask about the report or add client information…"
          className="min-h-0 flex-1 resize-none rounded-md border border-line bg-surface-raised p-2 text-sm outline-none focus:border-prism-500"
        />
        <button
          type="submit"
          aria-label="Send"
          disabled={sending || !input.trim()}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-prism-600 text-white hover:bg-prism-500 disabled:opacity-50"
        >
          {sending ? <Loader2 size={16} aria-hidden="true" className="animate-spin" /> : <Send size={16} aria-hidden="true" />}
        </button>
      </form>
    </div>
  )
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 self-end">
      <p className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-prism-600 px-3 py-2 text-sm text-white">{text}</p>
      <User size={14} aria-label="You" className="mt-2 shrink-0 text-muted" />
    </div>
  )
}

function AssistantBubble({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <Bot size={14} aria-label="PRISM" className="mt-2 shrink-0 text-fiber-cyan" />
      <div className="flex min-w-0 flex-1 flex-col gap-2 rounded-lg border border-line bg-surface-raised px-3 py-2">
        {children}
      </div>
    </div>
  )
}
