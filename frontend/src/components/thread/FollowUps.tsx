import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlert, Loader2, Wrench } from 'lucide-react'
import { api } from '../../api'
import { useRunEvents } from '../../hooks/useRunEvents'
import { STAGE_LABELS } from '../../pipeline/reducer'
import { reportSuggestions } from '../../suggestions'
import type { Turn } from '../../state/useAssessment'
import type { ReportViewData } from '../report/ReportView'
import { DiffView } from '../DiffView'
import { RefusalCard } from '../RefusalCard'
import { SuggestionChips } from '../SuggestionChips'
import { UserBubble } from './UserBubble'

export interface FollowUpsProps {
  turns: Turn[]
  sessionId: string
  /** Current report: source of citation labels and suggestion chips. */
  report: ReportViewData | null
  citations: Record<string, string>
  onCite: (cardId: string) => void
  /** Fill the composer (suggestion chips, proposed facts, refusal rephrasings). */
  onFill: (text: string) => void
  onRunCompleted: (runId: string) => void
}

const factText = (f: string | { text: string }) => (typeof f === 'string' ? f : f.text)

// ---------------------------------------------------------------- a run started by the agent

interface RunTurnProps {
  sessionId: string
  runId: string
  /** Expected version number while the run streams (the stored `reports[]` decide once it is done). */
  expected: number
  onCompleted: (runId: string) => void
  onFill: (text: string) => void
}

/**
 * A chat message that started a new run: streams its stage, then reloads the session detail and shows
 * the diff between the run's report version and the one before it (both taken from `reports[]`).
 */
export function RunTurn({ sessionId, runId, expected, onCompleted, onFill }: RunTurnProps) {
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

  useEffect(() => {
    if (done) void queryClient.invalidateQueries({ queryKey: ['session', sessionId] })
  }, [done, queryClient, sessionId])

  const reports = session.data?.reports ?? []
  const to = reports.find((r) => r.run_id === runId)?.version ?? null
  const from =
    to === null ? null : reports.reduce<number | null>((b, r) => (r.version < to && (b === null || r.version > b) ? r.version : b), null)
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
    if (done) completedRef.current(runId)
  }, [done, runId])

  if (state.status === 'refused') {
    return <RefusalCard reason={state.refusal?.reason ?? ''} label={state.refusal?.label} suggestions={state.refusal?.suggestions} onExample={onFill} />
  }
  if (state.status === 'failed') {
    return (
      <p role="alert" className="inline-error">
        <CircleAlert size={16} strokeWidth={1.75} aria-hidden="true" /> Run v{to ?? expected} failed: {state.error}
      </p>
    )
  }
  if (!done) {
    const running = Object.entries(state.stages).find(([, s]) => s.status === 'running')?.[0] as keyof typeof STAGE_LABELS | undefined
    return (
      <div aria-live="polite" style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 14 }}>
        <p style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Loader2 size={16} strokeWidth={2} className="spin" aria-hidden="true" style={{ color: 'var(--violet)' }} />
          <span>New version v{expected} running…</span>
        </p>
        {running && <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>Stage: {STAGE_LABELS[running]}</p>}
        {connection === 'error' && <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>Lost the connection to the run.</p>}
      </div>
    )
  }
  const muted = { margin: 0, fontSize: 14, color: 'var(--muted)' } as const
  if (to === null) {
    return session.isFetching || session.isPending ? (
      <p style={muted}>Run finished. Loading the new version…</p>
    ) : (
      <p style={muted}>Run finished, but its report is not listed in this session.</p>
    )
  }
  if (from === null) return <p style={muted}>Version v{to} ready (no earlier version to compare).</p>
  if (diff.isPending) return <p style={muted}>Version v{to} ready. Loading changes…</p>
  if (diff.isError || !diff.data) return <p style={muted}>Version v{to} ready. The changes could not be loaded.</p>
  return <DiffView diff={diff.data} from={from} to={to} />
}

// ---------------------------------------------------------------- the conversation

/** Follow-up messages rendered inline in the thread: user bubbles and plain assistant text. */
export function FollowUps({ turns, sessionId, report, citations, onCite, onFill, onRunCompleted }: FollowUpsProps) {
  const suggestions = reportSuggestions(report ?? undefined)
  return (
    <>
      {turns.map((t) => {
        switch (t.kind) {
          case 'history':
            return t.message.role === 'user' ? (
              <UserBubble key={t.id} text={t.message.text} />
            ) : (
              <div key={t.id} className="assistant-text">
                <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{t.message.text}</p>
              </div>
            )
          case 'user':
            return <UserBubble key={t.id} text={t.text} />
          case 'answer':
            return (
              <div key={t.id} className="assistant-text">
                <p style={{ margin: 0, whiteSpace: 'pre-wrap', color: t.offline ? 'var(--muted)' : undefined }}>{t.answer.text}</p>
                {t.answer.cited_ids.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {t.answer.cited_ids.map((id) => {
                      const label = citations[id] ?? id
                      return (
                        <button key={id} type="button" className="cite-chip" aria-label={`Show source ${label}`} onClick={() => onCite(id)}>
                          [{label}]
                        </button>
                      )
                    })}
                  </div>
                )}
                {t.answer.tool_calls.length > 0 && (
                  <p style={{ margin: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
                    <Wrench size={12} aria-hidden="true" /> Tools used:
                    {t.answer.tool_calls.map((c, i) => (
                      <span key={i} className="mono" style={{ padding: '0 6px', borderRadius: 6, background: 'var(--soft)' }}>
                        {c.name}
                      </span>
                    ))}
                  </p>
                )}
                {t.answer.proposed_facts.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
                    <span style={{ color: 'var(--muted)' }}>Possible client facts (send to confirm and start a new version):</span>
                    {t.answer.proposed_facts.map((f, i) => (
                      <button key={i} type="button" className="chip" onClick={() => onFill(factText(f))}>
                        {factText(f)}
                      </button>
                    ))}
                  </div>
                )}
                {!t.offline && <SuggestionChips suggestions={suggestions} onPick={onFill} />}
              </div>
            )
          case 'run':
            return (
              <div key={t.id} className="assistant-text">
                <RunTurn sessionId={sessionId} runId={t.runId} expected={t.expected} onCompleted={onRunCompleted} onFill={onFill} />
              </div>
            )
          case 'refused':
            return <RefusalCard key={t.id} reason={t.reason} suggestions={t.suggestions} onExample={onFill} />
          case 'error':
            return (
              <p key={t.id} role="alert" className="inline-error">
                <CircleAlert size={16} strokeWidth={1.75} aria-hidden="true" /> {t.text}
              </p>
            )
        }
      })}
    </>
  )
}
