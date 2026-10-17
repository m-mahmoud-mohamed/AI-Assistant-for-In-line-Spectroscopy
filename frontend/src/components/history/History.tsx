import { useMemo } from 'react'
import { ChevronRight, History as HistoryIcon, Plus } from 'lucide-react'
import { BlurIn } from '../../motion'
import { formatSessionDate, sessionTitle, sortSessions } from '../../sessions'
import type { Session } from '../../types'

export interface HistoryProps {
  sessions: Session[]
  loading: boolean
  offline: boolean
  selectedId: string | null
  onOpen: (id: string) => void
  onNew: () => void
}

/** The user's own stored sessions, newest first; clicking one opens its thread. */
export function History({ sessions, loading, offline, selectedId, onOpen, onNew }: HistoryProps) {
  const list = useMemo(() => sortSessions(sessions), [sessions])
  return (
    <section className="thread-scroll" aria-labelledby="history-title">
      <div className="history-inner">
        <BlurIn y={8}>
          <h1 id="history-title" className="section-title" style={{ fontSize: 24, marginBottom: 6 }}>
            History
          </h1>
          <p style={{ margin: '0 0 24px', color: 'var(--muted)', fontSize: 14 }}>Your earlier assessments on this machine.</p>
        </BlurIn>
        {loading && !offline && (
          <p role="status" style={{ margin: 0, color: 'var(--muted)' }}>
            Loading assessments…
          </p>
        )}
        {offline && (
          <p className="notice" role="status" style={{ margin: 0 }}>
            PRISM's API is not reachable — start it with <code>make api</code>.
          </p>
        )}
        {!loading && !offline && list.length === 0 && (
          <BlurIn y={8} delay={80} className="history-empty">
            <HistoryIcon size={28} strokeWidth={1.5} aria-hidden="true" style={{ color: 'var(--violet)' }} />
            <p style={{ margin: 0, color: 'var(--ink)', fontWeight: 500 }}>No assessments yet</p>
            <p style={{ margin: 0, fontSize: 14 }}>Paste a client enquiry and the finished assessment will be listed here.</p>
            <button type="button" className="btn btn-primary" onClick={onNew}>
              <Plus size={16} strokeWidth={1.75} aria-hidden="true" /> New enquiry
            </button>
          </BlurIn>
        )}
        {list.length > 0 && (
          <ul className="history-list">
            {list.map((s, i) => (
              <li key={s.id}>
                <BlurIn y={6} delay={60 + Math.min(i, 8) * 40}>
                  <button type="button" className="history-row" aria-current={s.id === selectedId ? 'true' : undefined} onClick={() => onOpen(s.id)}>
                    <span className="clamp-2" style={{ color: 'var(--ink)', fontWeight: 500 }}>
                      {sessionTitle(s)}
                    </span>
                    <time dateTime={s.created_at} className="tabular" style={{ fontSize: 13, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                      {formatSessionDate(s.created_at)}
                    </time>
                    <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" style={{ color: 'var(--muted)' }} />
                  </button>
                </BlurIn>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
