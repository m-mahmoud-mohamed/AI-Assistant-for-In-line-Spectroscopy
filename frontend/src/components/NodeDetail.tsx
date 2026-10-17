import { useEffect, useId, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { STAGE_LABELS, type StageState } from '../pipeline/reducer'
import { NODE_STATUS, formatSeconds } from '../pipeline/status'
import type { Stage } from '../types'

interface NodeDetailProps {
  stage: Stage
  state: StageState
  onClose: () => void
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-line pt-3">
      <h3 className="mb-2 text-xs font-bold uppercase tracking-[0.16em] text-muted">{title}</h3>
      {children}
    </section>
  )
}

/** Event time (seconds since the epoch) as a local HH:MM:SS.mmm clock. */
const formatTs = (ts: number) =>
  Number.isFinite(ts)
    ? new Date(ts * 1000).toLocaleTimeString(undefined, { hour12: false, fractionalSecondDigits: 3 })
    : String(ts)

/** Glass-box drawer: the stage's status, findings and every raw event with its payload JSON. */
export function NodeDetail({ stage, state, onClose }: NodeDetailProps) {
  const headingId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const { label, icon: Icon, color } = NODE_STATUS[state.status]

  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <aside
      role="dialog"
      aria-labelledby={headingId}
      className="fixed inset-y-0 right-0 z-50 flex w-[min(440px,100vw)] flex-col gap-3 overflow-y-auto border-l border-line bg-surface p-4 shadow-2xl"
    >
      <header className="flex items-start justify-between gap-2">
        <div>
          <h2 id={headingId} className="text-base font-bold">
            {STAGE_LABELS[stage]} stage
          </h2>
          <p className="mt-1 flex items-center gap-2 text-sm">
            <span className="inline-flex items-center gap-1 font-semibold" data-status={state.status}>
              <Icon size={14} aria-hidden="true" style={{ color }} />
              {label}
            </span>
            {state.seconds !== null && <span className="font-mono text-xs text-muted">{formatSeconds(state.seconds)}</span>}
          </p>
        </div>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close stage details"
          className="rounded p-1 text-muted hover:bg-surface-raised hover:text-fg"
        >
          <X size={18} aria-hidden="true" />
        </button>
      </header>

      {state.rules.length > 0 && (
        <Section title="Fired rules">
          <ul className="flex flex-col gap-2 text-sm">
            {state.rules.map((r, i) => (
              <li key={i}>
                <span className="font-mono font-semibold">{r.rule_id}</span>{' '}
                <span className="rounded border border-line px-1 text-xs">{r.severity}</span>
                <p className="text-muted">{r.message}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {state.issues.length > 0 && (
        <Section title="Issues">
          <ul className="flex flex-col gap-2 text-sm">
            {state.issues.map((issue, i) => (
              <li key={i}>
                <span className="font-mono font-semibold">{issue.check_id}</span>{' '}
                <span className="rounded border border-line px-1 text-xs">{issue.severity}</span>{' '}
                <span className="font-mono text-xs text-muted">{issue.path}</span>
                <p className="text-muted">{issue.message}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {state.evidenceIds.length > 0 && (
        <Section title="Evidence selected">
          <ul className="flex flex-wrap gap-1">
            {state.evidenceIds.map((id) => (
              <li key={id} className="rounded border border-line px-1.5 font-mono text-xs">
                {id}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={`Events (${state.events.length})`}>
        {state.events.length === 0 ? (
          <p className="text-sm text-muted">No events for this stage yet.</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {state.events.map((e) => (
              <li key={e.seq} className="rounded border border-line">
                <div className="flex items-center justify-between gap-2 border-b border-line px-2 py-1 text-xs">
                  <span className="font-mono font-semibold">{e.type}</span>
                  <span className="font-mono text-muted">
                    #{e.seq} · {formatTs(e.ts)}
                  </span>
                </div>
                <pre className="overflow-x-auto px-2 py-1 font-mono text-[11px] leading-4">
                  {JSON.stringify(e.payload, null, 2)}
                </pre>
              </li>
            ))}
          </ol>
        )}
      </Section>
    </aside>
  )
}
