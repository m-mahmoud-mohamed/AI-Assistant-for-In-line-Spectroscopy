import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, MessageCircle, Plus, Search } from 'lucide-react'
import { api } from '../../api'
import { BlurIn, Orb, Skeleton } from '../../motion'
import { formatSessionDate, sessionTitle, sortSessions } from '../../sessions'
import type { Session } from '../../types'
import { relativeDate } from './relativeTime'
import { sessionSummary } from './summary'
import '../panel/panel.css'

export interface HistoryProps {
  sessions: Session[]
  loading: boolean
  offline: boolean
  selectedId: string | null
  onOpen: (id: string) => void
  onNew: () => void
  onSearch: () => void
  onRetry: () => void
}

function Row({ session, current, onOpen }: { session: Session; current: boolean; onOpen: (id: string) => void }) {
  const detail = useQuery({
    queryKey: ['session', session.id],
    queryFn: () => api.getSession(session.id),
    staleTime: 30_000,
    retry: false,
  })
  const summary = detail.data ? sessionSummary(detail.data) : null
  const when = relativeDate(session.created_at)
  return (
    <button type="button" className="hs-row" aria-current={current ? 'true' : undefined} onClick={() => onOpen(session.id)}>
      <span className="hs-icon" aria-hidden="true">
        <MessageCircle size={18} strokeWidth={1.75} />
      </span>
      <span className="hs-main">
        <span className="hs-title clamp-2">{sessionTitle(session)}</span>
        <time dateTime={session.created_at} title={formatSessionDate(session.created_at)} className="hs-date tabular">
          {when || formatSessionDate(session.created_at)}
        </time>
      </span>
      <span className="hs-badges">
        {detail.isPending && <Skeleton width={78} height={22} radius={999} />}
        {summary?.pill && <span className={`pill ${summary.pill.tone}`}>{summary.pill.label}</span>}
        {summary?.version != null && <span className="hs-version tabular">v{summary.version}</span>}
      </span>
      <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" className="hs-chev" />
    </button>
  )
}

/** The user's own stored sessions, newest first, searchable by title; clicking one opens its thread. */
export function History({ sessions, loading, offline, selectedId, onOpen, onNew, onSearch, onRetry }: HistoryProps) {
  const list = useMemo(() => sortSessions(sessions), [sessions])
  const shown = list
  return (
    <section className="history-scroll" aria-labelledby="history-title">
      <div className="history-inner hs">
        <BlurIn y={8}>
          <div className="hs-head">
            <div>
              <h1 id="history-title" className="hs-h1">
                Assessments
              </h1>
              <p className="hs-sub">Your earlier assessments on this machine.</p>
            </div>
            {list.length > 0 && (
              <button className="btn" onClick={onSearch}><Search size={16} aria-hidden="true" />Search assessments <kbd className="kbd">Ctrl K</kbd></button>
            )}
          </div>
        </BlurIn>
        {loading && !offline && (
          <p role="status" className="hs-note">
            Loading assessments…
          </p>
        )}
        {offline && (
          <p className="notice" role="status" style={{ margin: 0 }}>
            PRISM's API is not reachable — start it with <code>make api</code>. <button className="link-btn" onClick={onRetry}>Retry connection</button>
          </p>
        )}
        {!loading && !offline && list.length === 0 && (
          <BlurIn y={8} delay={80} className="hs-empty">
            <Orb size={56} />
            <p>
              <strong>No assessments yet</strong> — paste a client enquiry to start.
            </p>
            <button type="button" className="btn btn-primary" onClick={onNew}>
              <Plus size={16} strokeWidth={1.75} aria-hidden="true" /> New enquiry
            </button>
          </BlurIn>
        )}
        {shown.length > 0 && (
          <ul className="hs-list">
            {shown.map((s, i) => (
              <li key={s.id}>
                <BlurIn y={6} delay={60 + Math.min(i, 8) * 40}>
                  <Row session={s} current={s.id === selectedId} onOpen={onOpen} />
                </BlurIn>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
