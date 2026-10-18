import './thread.css'
import { Fragment, useEffect, useRef, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BadgeCheck, CircleAlert, CircleCheck, Globe, Sparkles, Wrench } from 'lucide-react'
import { api } from '../../api'
import { useRunEvents } from '../../hooks/useRunEvents'
import { RevealWords } from '../../motion'
import { reportSuggestions } from '../../suggestions'
import type { Assessment, AnswerResponse, Turn } from '../../state/useAssessment'
import type { ChatWebSource } from '../../types'
import { DiffView } from '../DiffView'
import { RefusalCard } from '../RefusalCard'
import { Cite } from '../report/ClaimText'
import { SuggestionChips } from '../SuggestionChips'
import { PipelineSteps, PipelineSummary } from './PipelineSteps'
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
      {paragraphs.map((p, i) => {
        const offset = Math.min(i * 90, 360)
        return (
          <p key={i} className="rs-p rs-answer">
            {reveal ? <RevealWords text={p} delay={offset} stagger={25} perWordCap={900 - offset} duration={380} blur={4} rise="0.2em" /> : p}
          </p>
        )
      })}
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

/** "Report v2 ready — Open": the new version waits in the conversation; opening it switches the report pane to it. */
export function VersionNotice({ version, active, onOpen }: { version: number; active: boolean; onOpen: () => void }) {
  return (
    <p className="notice vn" role="status">
      <CircleCheck size={16} strokeWidth={1.75} aria-hidden="true" style={{ color: 'var(--status-ok)' }} />
      <span className="vn-text">Report v{version} ready</span>
      {active ? (
        <span className="rs-muted-note">Showing</span>
      ) : (
        <button type="button" className="btn btn-sm" onClick={onOpen} aria-label={`Open report v${version}`}>
          Open
        </button>
      )}
    </p>
  )
}

interface RunTurnProps {
  assessment: Assessment
  sessionId: string
  runId: string
  /** Expected version number while the run streams (the stored `reports[]` decide once it is done). */
  expected: number
}

/**
 * A chat message that started a new run: "Report vN" below the follow-up streams the run, then shows what changed from
 * the version before and a notice that opens the new version in the report pane. The report itself never moves in here.
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

  const completedRef = useRef(a.onRunCompleted)
  useEffect(() => {
    completedRef.current = a.onRunCompleted
  })
  useEffect(() => {
    if (done) completedRef.current()
  }, [done])

  const label = `Report v${to ?? expected}`
  const heading = (
    <h3 className="rn-title">
      <Sparkles size={16} strokeWidth={1.75} aria-hidden="true" />
      {label}
    </h3>
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
    <div className="assistant-block" role="region" aria-label={label}>
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
      {done && to !== null && <VersionNotice version={to} active={a.currentVersion === to} onOpen={() => a.selectVersion(to)} />}
    </div>
  )
}

// ---------------------------------------------------------------- the conversation

/** Follow-up messages rendered inline in the thread: user bubbles and assistant answers styled like the Results. */
export function FollowUps({ assessment: a }: FollowUpsProps) {
  const { turns, selectedId, report, versions } = a
  if (!selectedId) return null
  const suggestions = reportSuggestions(report ?? undefined)
  const first = versions[0]?.version
  return (
    <>
      {turns.map((t: Turn) => {
        switch (t.kind) {
          case 'history': {
            const m = t.message
            // a stored message that started a later report version carries its "ready" notice, as when it happened
            const started = m.run_id ? versions.find((v) => v.run_id === m.run_id && v.version !== first) : undefined
            return (
              <Fragment key={t.id}>
                {m.role === 'user' ? <UserBubble text={m.text} /> : <AnswerText text={m.text} />}
                {started && m.role === 'user' && <VersionNotice version={started.version} active={a.currentVersion === started.version} onOpen={() => a.selectVersion(started.version)} />}
              </Fragment>
            )
          }
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
