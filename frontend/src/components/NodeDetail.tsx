import { useEffect, useId, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { STAGE_LABELS, type StageState } from '../pipeline/reducer'
import { NODE_STATUS, formatSeconds } from '../pipeline/status'
import type { Stage } from '../types'
import { useFocusTrap } from './shell/useFocusTrap'
import './panel/panel.css'

interface NodeDetailProps {
  stage: Stage
  state: StageState
  onClose: () => void
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="nd-section">
      <h3>{title}</h3>
      {children}
    </section>
  )
}

/** Event time (seconds since the epoch) as a local HH:MM:SS.mmm clock. */
const formatTs = (ts: number) =>
  Number.isFinite(ts)
    ? new Date(ts * 1000).toLocaleTimeString(undefined, { hour12: false, fractionalSecondDigits: 3 })
    : String(ts)

const WEB_STATUS_PILL: Record<string, string> = {
  VERIFIED: 'pill-ok',
  UNVERIFIED: 'pill-warn',
  UNREACHABLE: 'pill-warn',
  BLOCKED: 'pill-bad',
  SKIPPED: 'pill-info',
  ERROR: 'pill-bad',
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** Glass-box drawer: the stage's status, findings and every raw event with its payload JSON. */
export function NodeDetail({ stage, state, onClose }: NodeDetailProps) {
  const headingId = useId()
  const ref = useRef<HTMLElement>(null)
  const { label, icon: Icon } = NODE_STATUS[state.status]
  useFocusTrap(ref, true)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // The web stage lists every source it considered (one `web_source` event each), live.
  const webSources = state.events.filter((e) => e.type === 'web_source')

  return (
    <aside ref={ref} role="dialog" aria-modal="true" aria-labelledby={headingId} className="ov-drawer nd" data-narrow>
      <header className="ov-head">
        <div style={{ minWidth: 0 }}>
          <h2 id={headingId} className="ov-title">
            {STAGE_LABELS[stage]} stage
          </h2>
          <p className="ov-sub" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="pg-badge" data-status={state.status}>
              <Icon size={14} strokeWidth={2} aria-hidden="true" />
              {label}
            </span>
            {state.seconds !== null && <span className="tabular">{formatSeconds(state.seconds)}</span>}
          </p>
        </div>
        <button type="button" className="icon-square" onClick={onClose} aria-label="Close stage details">
          <X size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </header>

      {webSources.length > 0 && (
        <Section title={`Sources considered (${webSources.length})`}>
          <ul className="nd-list">
            {webSources.map((e) => {
              const p = e.payload
              const status = str(p.status)
              return (
                <li key={e.seq}>
                  <span className={`pill ${WEB_STATUS_PILL[status] ?? 'pill-info'}`}>{status.toLowerCase() || 'unknown'}</span>{' '}
                  <span className="nd-strong">{str(p.title) || str(p.domain) || str(p.url)}</span>
                  {str(p.domain) && <span className="nd-muted"> · {str(p.domain)}</span>}
                  {str(p.reason) && <p className="nd-muted">{str(p.reason)}</p>}
                </li>
              )
            })}
          </ul>
        </Section>
      )}

      {state.rules.length > 0 && (
        <Section title="Fired rules">
          <ul className="nd-list">
            {state.rules.map((r, i) => (
              <li key={i}>
                <span className="mono nd-strong">{r.rule_id}</span> <span className="pill pill-info">{r.severity}</span>
                <p className="nd-muted">{r.message}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {state.issues.length > 0 && (
        <Section title="Issues">
          <ul className="nd-list">
            {state.issues.map((issue, i) => (
              <li key={i}>
                <span className="mono nd-strong">{issue.check_id}</span> <span className="pill pill-warn">{issue.severity}</span>{' '}
                <span className="mono nd-muted">{issue.path}</span>
                <p className="nd-muted">{issue.message}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {state.evidenceIds.length > 0 && (
        <Section title="Evidence selected">
          <ul className="nd-tags">
            {state.evidenceIds.map((id) => (
              <li key={id} className="mono">
                {id}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={`Events (${state.events.length})`}>
        {state.events.length === 0 ? (
          <p className="nd-muted">No events for this stage yet.</p>
        ) : (
          <ol className="nd-events">
            {state.events.map((e) => (
              <li key={e.seq}>
                <div className="nd-event-head">
                  <span className="mono nd-strong">{e.type}</span>
                  <span className="mono nd-muted">
                    #{e.seq} · {formatTs(e.ts)}
                  </span>
                </div>
                <pre>{JSON.stringify(e.payload, null, 2)}</pre>
              </li>
            ))}
          </ol>
        )}
      </Section>
    </aside>
  )
}
