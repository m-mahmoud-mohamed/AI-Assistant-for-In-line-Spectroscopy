import { Handshake } from 'lucide-react'
import { sentenceCase } from '../../labels'
import type { FeasibilityPlan, Segment } from '../../types'
import { ClaimText } from './ClaimText'

type SegmentKey = 'samples_and_states' | 'reference_measurements' | 'setup' | 'comparison' | 'validation' | 'not_demonstrated'

const SECTIONS: { key: SegmentKey; label: string }[] = [
  { key: 'samples_and_states', label: 'Samples and states' },
  { key: 'reference_measurements', label: 'References needed' },
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

/** Feasibility plan: the objective, clarify-first items, every step as a numbered timeline, then the labelled plan details and the go / no-go basis. */
export function PlanTimeline({ plan, onCite, citations }: PlanTimelineProps) {
  const segs = (segments: Segment[]) => <ClaimText segments={segments} onCite={onCite} citations={citations} empty="Not specified." />
  return (
    <div className="plan">
      {plan.objective && <p className="rs-p plan-objective">{sentenceCase(plan.objective)}</p>}
      {plan.clarify_first.length > 0 && (
        <section aria-label="Clarify first" className="rs-sub">
          <span className="rs-sub-label">Clarify first</span>
          <ul className="rs-list">
            {plan.clarify_first.map((item, i) => (
              <li key={i}>{item.replace(/[.;]+$/, '')}</li>
            ))}
          </ul>
        </section>
      )}
      {plan.steps.length > 0 && (
        <ol className="rs-steps" aria-label="Plan steps">
          {plan.steps.map((step, i) => (
            <li key={i} aria-label={`Step ${i + 1}: ${step}`} className="rs-step">
              <span className="rs-step-n tabular" aria-hidden="true">
                {i + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      )}
      <div className="plan-details">
        {SECTIONS.map(({ key, label }) => (
          <section key={key} aria-label={label} className="rs-sub">
            <span className="rs-sub-label">{label}</span>
            {segs(plan[key])}
          </section>
        ))}
        <section aria-label="Go / no-go" className="rs-sub">
          <span className="rs-sub-label">Go / no-go</span>
          {/* Thresholds are never invented: they are set together with the client. */}
          <p className="rs-agree">
            <Handshake size={12} strokeWidth={2} aria-hidden="true" />
            Criteria to be agreed with client
          </p>
          <ClaimText segments={plan.go_no_go} onCite={onCite} citations={citations} />
        </section>
      </div>
    </div>
  )
}
