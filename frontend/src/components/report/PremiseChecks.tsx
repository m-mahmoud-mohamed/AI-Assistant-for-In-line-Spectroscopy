import { CircleCheck, CircleHelp, CircleX, type LucideIcon } from 'lucide-react'
import type { PremiseCheck, PremiseVerdict } from '../../types'
import { ClaimText } from './ClaimText'

const PREMISE: Record<PremiseVerdict, { label: string; icon: LucideIcon; tone: 'ok' | 'warn' | 'bad' }> = {
  SUPPORTED: { label: 'Supported', icon: CircleCheck, tone: 'ok' },
  CONTRADICTED: { label: 'Contradicted', icon: CircleX, tone: 'bad' },
  UNVERIFIABLE: { label: 'Unverifiable', icon: CircleHelp, tone: 'warn' },
}

interface PremiseChecksProps {
  checks: PremiseCheck[]
  onCite?: (cardId: string) => void
  citations?: Record<string, string>
}

/**
 * The client's own assumptions, checked against the evidence: a verdict pill, the premise, the explanation.
 * A contradicted or unverifiable premise changes the decision, so it sits on a tinted panel; supported ones stay plain.
 */
export function PremiseChecks({ checks, onCite, citations }: PremiseChecksProps) {
  return (
    <ul className="pc-list">
      {checks.map((c, i) => {
        const v = PREMISE[c.verdict]
        return (
          <li key={i} className="pc" data-verdict={c.verdict} data-problem={c.verdict === 'SUPPORTED' ? undefined : 'true'}>
            <div className="rc-head">
              <span className={`pill pill-${v.tone}`}>
                <v.icon size={13} strokeWidth={2} aria-hidden="true" />
                {v.label}
              </span>
              <strong className="rs-strong">{c.premise}</strong>
            </div>
            <ClaimText segments={c.explanation} onCite={onCite} citations={citations} />
          </li>
        )
      })}
    </ul>
  )
}
