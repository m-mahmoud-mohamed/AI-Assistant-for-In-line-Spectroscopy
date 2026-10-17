import './thread.css'
import { useEffect, useRef, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BadgeCheck, CircleAlert, Globe, Sparkles, Wrench } from 'lucide-react'
import { api, isStillRunning } from '../../api'
import { useRunEvents } from '../../hooks/useRunEvents'
import { reportSuggestions } from '../../suggestions'
import type { Assessment, AnswerResponse, Turn } from '../../state/useAssessment'
import { isRefusedReport, type ChatWebSource } from '../../types'
import { DiffView } from '../DiffView'
import { RefusalCard } from '../RefusalCard'
import { Cite } from '../report/ClaimText'
import { Rv } from '../report/reveal'
import { RevealContext, SectionStartContext } from '../report/revealState'
import type { ReportViewData } from '../report/ReportView'
import { SuggestionChips } from '../SuggestionChips'
import { PipelineSteps, PipelineSummary } from './PipelineSteps'
import { ReportBlock } from './ReportBlock'
import { UserBubble } from './UserBubble'

export interface FollowUpsProps {
  /** The app state: follow-up turns, the open session, the report (citations, suggestion chips) and actions. */
  assessment: Assessment
}

const factText = (f: string | { text: string }) => (typeof f === 'string' ? f : f.text)

// ---------------------------------------------------------------- assistant answer text

/** Small chip for a verified web source an answer cites; opens the page in a new tab. */
export function WebSourceChip({ source }: { source: ChatWebSource }) {
  return (
    <a className="web-chip" href={source.url} target="_blank" rel="noreferrer noopener" title={source.title || source.url}>
      <Globe size={13} strokeWidth={2} aria-hidden="true" />
      <span className="web-chip-domain">{source.domain}</span>
      <BadgeCheck size={13} strokeWidth={2} aria-label="Verified" style={{ color: 'var(--status-ok)' }} />
    </a>
  )
}

interface AnswerTextProps {
  text: string
  /** Reveal the words one by one (a fresh answer); stored messages render at once. */
  reveal?: boolean
  muted?: boolean
  citedIds?: string[]
  citations?: Record<string, string>
  onCite?: (id: string) => void
  webSources?: ChatWebSource[] | null
  children?: ReactNode
}

/** An assistant message styled like the Results text: paragraphs, citation chips, verified web-source chips. */
export function AnswerText({ text, reveal = false, muted = false, citedIds = [], citations = {}, onCite, webSources, children }: AnswerTextProps) {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim().length > 0)
  return (
    <div className="assistant-text rs" data-muted={muted ? 'true' : undefined}>
      <RevealContext.Provider value={{ enabled: reveal }}>
        <SectionStartContext.Provider value={0}>
          {paragraphs.map((p, i) => (
            <p key={i} className="rs-p rs-answer">
              <Rv item={i}>{p}</Rv>
            </p>
          ))}
        </SectionStartContext.Provider>
      </RevealContext.Provider>
      {(citedIds.length > 0 || (webSources?.length ?? 0) > 0) && (
        <div className="answer-sources">
          {citedIds.map((id) => (
            <Cite key={id} id={id} label={citations[id] ?? id} onCite={onCite} />
          ))}
          {webSources?.map((w) => <WebSourceChip key={w.url} source={w} />)}
        </div>
      )}
      {children}
    </div>
  )
}

// ---------------------------------------------------------------- a run started by the agent

interface RunTurnProps {
  assessment: Assessment
  sessionId: string
  runId: string
  /** Expected version number while the run streams (the stored `reports[]` decide once it is done). */
  expected: number
}

/**
 * A chat message that started a new run: a new assistant block "Report vN" below the follow-up. It streams the
 * run, then shows what changed from the version before and the new report (sources, results, actions).
 */
export function RunTurn({ assessment: a, sessionId, runId, expected }: RunTurnProps) {
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

  // Same cache key as the main report query, so choosing this version in the top bar reuses it.
  const reportQuery = useQuery({
    queryKey: ['report', runId],
    queryFn: () => api.getReport(runId),
    enabled: done,
    retry: (count, err) => isStillRunning(err) && count < 300,
    retryDelay: 2000,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })
  const live = reportQuery.data && !isRefusedReport(reportQuery.data) ? reportQuery.data : null
  const body: ReportViewData | null = (() => {
    if (!live) return null
    const { findings: _findings, scope: _scope, ...rest } = live
    return rest
  })()

  const completedRef = useRef(a.onRunCompleted)
  useEffect(() => {
    completedRef.current = a.onRunCompleted
  })
  useEffect(() => {
    if (done) completedRef.current()
  }, [done])

  const label = `Report v${to ?? expected}`
  const heading = (
    <h2 className="section-title version-label">
      <Sparkles size={20} strokeWidth={1.75} aria-hidden="true" />
      {label}
    </h2>
  )
  const muted = (text: string) => <p className="rs-muted">{text}</p>

  if (state.status === 'refused') {
    return <RefusalCard reason={state.refusal?.reason ?? ''} label={state.refusal?.label} suggestions={state.refusal?.suggestions} onExample={a.fillComposer} />
  }
  if (state.status === 'failed') {
    return (
      <p role="alert" className="inline-error">
        <CircleAlert size={16} strokeWidth={1.75} aria-hidden="true" /> Run v{to ?? expected} failed: {state.error}
      </p>
    )
  }

  let changes: ReactNode = null
  if (done) {
    if (to === null) {
      changes = session.isFetching || session.isPending ? muted('Run finished. Loading the new version…') : muted('Run finished, but its report is not listed in this session.')
    } else if (from === null) changes = muted(`Version v${to} ready (no earlier version to compare).`)
    else if (diff.isPending) changes = muted(`Version v${to} ready. Loading changes…`)
    else if (diff.isError || !diff.data) changes = muted(`Version v${to} ready. The changes could not be loaded.`)
    else changes = <DiffView diff={diff.data} from={from} to={to} />
  }

  return (
    <div className="assistant-block" role="region" aria-label={label} data-follow-anchor>
      {heading}
      {!done && (
        <>
          <PipelineSteps state={state} />
          <p aria-live="polite" className="rs-muted">
            New version v{expected} running…
            {connection === 'error' && ' Lost the connection to the run.'}
          </p>
        </>
      )}
      {done && <PipelineSummary state={state} />}
      {changes}
      {done && !body && reportQuery.isFetching && muted('Loading the new report…')}
      {body && <ReportBlock assessment={a} report={body} rules={live?.findings ?? undefined} runId={runId} fresh />}
    </div>
  )
}

// ---------------------------------------------------------------- the conversation

/** Follow-up messages rendered inline in the thread: user bubbles and assistant answers styled like the Results. */
export function FollowUps({ assessment: a }: FollowUpsProps) {
  const { turns, selectedId, report } = a
  if (!selectedId) return null
  const suggestions = reportSuggestions(report ?? undefined)
  return (
    <>
      {turns.map((t: Turn) => {
        switch (t.kind) {
          case 'history':
            return t.message.role === 'user' ? (
              <UserBubble key={t.id} text={t.message.text} />
            ) : (
              <AnswerText key={t.id} text={t.message.text} />
            )
          case 'user':
            return <UserBubble key={t.id} text={t.text} />
          case 'answer':
            return <FreshAnswer key={t.id} t={t} assessment={a} suggestions={suggestions} />
          case 'run':
            return <RunTurn key={t.id} assessment={a} sessionId={selectedId} runId={t.runId} expected={t.expected} />
          case 'refused':
            return <RefusalCard key={t.id} reason={t.reason} suggestions={t.suggestions} onExample={a.fillComposer} />
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

function FreshAnswer({ t, assessment: a, suggestions }: { t: Extract<Turn, { kind: 'answer' }>; assessment: Assessment; suggestions: string[] }) {
  const answer: AnswerResponse = t.answer
  return (
    <AnswerText
      text={answer.text}
      reveal={!t.offline}
      muted={t.offline}
      citedIds={answer.cited_ids}
      citations={a.citations}
      onCite={a.cite}
      webSources={answer.web_sources}
    >
      {answer.tool_calls.length > 0 && (
        <p className="answer-tools">
          <Wrench size={12} aria-hidden="true" /> Tools used:
          {answer.tool_calls.map((c, i) => (
            <span key={i} className="mono">
              {c.name}
            </span>
          ))}
        </p>
      )}
      {answer.proposed_facts.length > 0 && (
        <div className="answer-facts">
          <span className="rs-muted">Possible client facts (send to confirm and start a new version):</span>
          {answer.proposed_facts.map((f, i) => (
            <button key={i} type="button" className="chip" onClick={() => a.fillComposer(factText(f))}>
              {factText(f)}
            </button>
          ))}
        </div>
      )}
      {!t.offline && <SuggestionChips suggestions={suggestions} onPick={a.fillComposer} />}
    </AnswerText>
  )
}
