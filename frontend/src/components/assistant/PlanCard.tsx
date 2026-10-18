import { useState } from 'react'
import { ChevronDown, Loader2, Minus } from 'lucide-react'
import { formatDuration } from '../../assistant/format'
import type { StepTiming } from '../../assistant/turnReducer'
import type { PlanStep } from '../../types'

interface PlanCardProps {
  steps: PlanStep[]
  times?: Record<string, StepTiming>
  /** The turn is over: the card folds to one line (click to open). */
  finished?: boolean
}

const STATUS_WORD: Record<PlanStep['status'], string> = { pending: 'Pending', active: 'In progress', done: 'Done', skipped: 'Skipped' }

/** The step's glyph: a hollow ring, a spinner, a check that draws itself the moment the step completes, or a dash. */
function StepIcon({ status }: { status: PlanStep['status'] }) {
  // The status the step had when it first appeared: a step that arrives already done (a replay) never draws its check.
  const [first] = useState(status)
  const live = first !== 'done' && status === 'done'
  if (status === 'active') return <Loader2 size={16} strokeWidth={2} className="spin as-plan-active" aria-hidden="true" />
  if (status === 'done') {
    return (
      <svg className="as-plan-check" data-live={live || undefined} width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="7" fill="var(--status-ok-bg)" />
        <path d="M4.8 8.2 7 10.4l4.2-4.6" stroke="var(--status-ok)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" pathLength={1} />
      </svg>
    )
  }
  if (status === 'skipped') return <Minus size={16} strokeWidth={1.75} className="as-plan-skip" aria-hidden="true" />
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" stroke="#c4c6cf" strokeWidth="1.5" />
    </svg>
  )
}

/** The plan as a checklist: pending, active (spinner), done (check and how long it took) and skipped. */
export function PlanCard({ steps, times = {}, finished = false }: PlanCardProps) {
  const [open, setOpen] = useState(false)
  if (steps.length === 0) return null
  const done = steps.filter((s) => s.status === 'done').length
  const collapsed = finished && !open
  const active = steps.find((s) => s.status === 'active')
  return (
    <section className="as-card as-plan" aria-label="Plan" data-collapsed={collapsed || undefined}>
      <header className="as-plan-head">
        {finished ? (
          <button type="button" className="as-plan-toggle" aria-expanded={!collapsed} onClick={() => setOpen((o) => !o)}>
            <span className="as-card-title">Plan</span>
            <span className="as-muted tabular">
              {done} of {steps.length} done
            </span>
            <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" data-open={!collapsed} />
          </button>
        ) : (
          <>
            <h3 className="as-card-title">Plan</h3>
            <span className="as-muted tabular" aria-live="polite">
              {active ? active.label : `${done} of ${steps.length} done`}
            </span>
          </>
        )}
      </header>
      {!collapsed && (
        <ol className="as-plan-list">
          {steps.map((s) => {
            const seconds = formatDuration(times[s.id]?.seconds)
            return (
              <li key={s.id} className="as-plan-step" data-status={s.status} aria-current={s.status === 'active' ? 'step' : undefined}>
                <span className="as-plan-icon">
                  <StepIcon status={s.status} />
                </span>
                <span className="as-plan-body">
                  <span className="as-plan-label">{s.label}</span>
                  <span className="sr-only">{STATUS_WORD[s.status]}</span>
                  {s.detail && <span className="as-plan-detail">{s.detail}</span>}
                </span>
                {s.status === 'done' && seconds && <span className="as-plan-time tabular">{seconds}</span>}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
