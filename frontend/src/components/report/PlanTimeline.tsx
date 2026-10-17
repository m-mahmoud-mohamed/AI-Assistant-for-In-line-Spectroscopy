import type { ReactNode } from 'react'
import { Handshake } from 'lucide-react'
import type { FeasibilityPlan, Segment } from '../../types'
import { ClaimText } from './ClaimText'

type SegmentKey = 'samples_and_states' | 'reference_measurements' | 'setup' | 'comparison' | 'validation' | 'not_demonstrated'

const SECTIONS: { key: SegmentKey; label: string }[] = [
  { key: 'samples_and_states', label: 'Samples and states' },
  { key: 'reference_measurements', label: 'Reference measurements' },
  { key: 'setup', label: 'Setup' },
  { key: 'comparison', label: 'Comparison' },
  { key: 'validation', label: 'Validation' },
  { key: 'not_demonstrated', label: 'Not demonstrated' },
]

interface PlanTimelineProps {
  plan: FeasibilityPlan
  onCite?: (cardId: string) => void
  citations?: Record<string, string>
}

function PlanSection({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="rounded-lg border border-line bg-surface p-4">
      <h3 id={id} className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">
        {label}
      </h3>
      {children}
    </section>
  )
}

/** Feasibility plan: objective, ordered steps as a timeline, then the labelled plan sections. */
export function PlanTimeline({ plan, onCite, citations }: PlanTimelineProps) {
  const segs = (segments: Segment[]) => (
    <ClaimText segments={segments} onCite={onCite} citations={citations} empty="Not specified." />
  )
  return (
    <div className="flex flex-col gap-4">
      <section aria-labelledby="plan-objective" className="rounded-lg border border-line bg-surface p-4">
        <h2 id="plan-objective" className="mb-1 text-sm font-bold">
          Objective
        </h2>
        <p className="text-sm">{plan.objective}</p>
        {plan.clarify_first.length > 0 && (
          <p className="mt-2 text-sm">
            <span className="font-semibold">Clarify first:</span> {plan.clarify_first.join('; ')}
          </p>
        )}
      </section>

      <section aria-labelledby="plan-steps">
        <h2 id="plan-steps" className="mb-2 text-sm font-bold">
          Steps
        </h2>
        <ol className="relative ml-3 border-l-2 border-prism-500 pl-6">
          {plan.steps.map((step, i) => (
            <li key={i} aria-label={`Step ${i + 1}: ${step}`} className="relative mb-3 last:mb-0">
              <span
                aria-hidden="true"
                className="absolute -left-[37px] flex h-6 w-6 items-center justify-center rounded-full bg-prism-500 font-mono text-xs font-semibold text-white"
              >
                {i + 1}
              </span>
              <span className="text-sm leading-6">{step}</span>
            </li>
          ))}
        </ol>
      </section>

      <div className="grid gap-3 md:grid-cols-2">
        {SECTIONS.map(({ key, label }) => (
          <PlanSection key={key} id={`plan-${key}`} label={label}>
            {segs(plan[key])}
          </PlanSection>
        ))}
        <PlanSection id="plan-go-no-go" label="Go / no-go">
          {/* Thresholds are never invented: they are set together with the client. */}
          <p className="mb-2 inline-flex items-center gap-1 rounded border border-dashed border-fiber-orange px-1.5 py-0.5 text-xs font-semibold">
            <Handshake size={12} aria-hidden="true" className="text-fiber-orange" />
            Criteria to be agreed with client
          </p>
          <ClaimText segments={plan.go_no_go} onCite={onCite} citations={citations} />
        </PlanSection>
      </div>
    </div>
  )
}
