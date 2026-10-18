import { useEffect, useRef, type KeyboardEvent } from 'react'
import { Check, ShieldQuestion, X } from 'lucide-react'

interface ApprovalCardProps {
  /** What the assistant wants to do ("Search scholarly literature"). */
  label: string
  why: string
  /** About how many model / API calls it uses. */
  costCalls: number | null
  resolved?: boolean
  decision?: 'approved' | 'declined'
  busy?: boolean
  error?: string | null
  autoFocus?: boolean
  onApprove: () => void
  onSkip: () => void
}

/** Asks before a costly or external action (web search, deep mode, a re-assessment): Skip or Approve. Esc skips. */
export function ApprovalCard({ label, why, costCalls, resolved = false, decision, busy = false, error, autoFocus = false, onApprove, onSkip }: ApprovalCardProps) {
  const approveRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!autoFocus || resolved) return
    const active = document.activeElement
    if (active && active !== document.body && !(active instanceof HTMLTextAreaElement && active.value === '')) return
    approveRef.current?.focus({ preventScroll: true })
  }, [autoFocus, resolved]) // when the card appears

  if (resolved) {
    return (
      <section className="as-card as-approval" aria-label="Approval" data-resolved="true">
        <header className="as-q-head">
          {decision === 'declined' ? (
            <X size={16} strokeWidth={1.75} className="as-muted-icon" aria-hidden="true" />
          ) : (
            <Check size={16} strokeWidth={2} className="as-ok" aria-hidden="true" />
          )}
          <h3 className="as-card-title">
            {decision === 'declined' ? 'Skipped' : decision === 'approved' ? 'Approved' : 'Decided'}: {label}
          </h3>
        </header>
      </section>
    )
  }

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (busy || e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    onSkip()
  }

  return (
    <section data-awaiting="true" className="as-card as-approval" aria-label="Approval needed" onKeyDown={onKeyDown} aria-busy={busy || undefined}>
      <header className="as-q-head">
        <ShieldQuestion size={16} strokeWidth={1.75} aria-hidden="true" />
        <h3 className="as-card-title">{label}</h3>
      </header>
      {why && <p className="as-approval-why">{why}</p>}
      {costCalls != null && costCalls > 0 && (
        <p className="as-muted as-approval-cost">
          Uses about <span className="tabular">{costCalls}</span> extra {costCalls === 1 ? 'call' : 'calls'}.
        </p>
      )}
      {error && (
        <p role="alert" className="inline-error as-q-error">
          {error}
        </p>
      )}
      <footer className="as-q-foot">
        <p className="as-hints" aria-hidden="true">
          <kbd className="kbd">Esc</kbd> skip
        </p>
        <div className="as-actions">
          <button type="button" className="btn btn-sm" onClick={onSkip} disabled={busy}>
            Skip
          </button>
          <button ref={approveRef} type="button" className="btn btn-sm btn-primary" onClick={onApprove} disabled={busy}>
            Approve
          </button>
        </div>
      </footer>
    </section>
  )
}
