import { Handshake } from 'lucide-react'
import type { FeasibilityPlan, Segment } from '../../types'
import { ClaimText } from './ClaimText'
import { Disclosure, MoreList } from './Disclosure'
import { Rv } from './reveal'

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

/** Feasibility plan: the objective, the steps as a numbered timeline, and the labelled plan details on demand. */
export function PlanTimeline({ plan, onCite, citations }: PlanTimelineProps) {
  const segs = (segments: Segment[]) => <ClaimText segments={segments} onCite={onCite} citations={citations} empty="Not specified." />
  const steps = plan.steps.map((step, i) => (
    <li key={i} aria-label={`Step ${i + 1}: ${step}`} className="rs-step">
      <span className="rs-step-n tabular" aria-hidden="true">
        {i + 1}
      </span>
      <span>
        <Rv item={i + 1}>{step}</Rv>
      </span>
    </li>
  ))
  return (
    <div className="rs-plan">
      <p className="rs-p">
        <Rv>{plan.objective}</Rv>
      </p>
      {plan.clarify_first.length > 0 && (
        <p className="rs-p">
          <strong className="rs-strong">Clarify first:</strong> {plan.clarify_first.join('; ')}
        </p>
      )}
      {steps.length > 0 && <MoreList items={steps} limit={6} noun="steps" ordered className="rs-steps" />}
      <Disclosure label="Show plan details">
        <div className="rs-plan-details">
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
      </Disclosure>
    </div>
  )
}
