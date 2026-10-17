import { CircleCheck, CircleHelp, CircleX, type LucideIcon } from 'lucide-react'
import type { PremiseCheck, PremiseVerdict } from '../../types'
import { ClaimText } from './ClaimText'
import { Rv } from './reveal'

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

/** The client's own assumptions, checked against the evidence: a verdict pill, the premise, the explanation. */
export function PremiseChecks({ checks, onCite, citations }: PremiseChecksProps) {
  return (
    <ul className="rs-list">
      {checks.map((c, i) => {
        const v = PREMISE[c.verdict]
        return (
          <li key={i}>
            <div className="rs-rec-head">
              <span className={`pill pill-${v.tone}`}>
                <v.icon size={13} strokeWidth={2} aria-hidden="true" />
                {v.label}
              </span>
              <strong className="rs-strong">
                <Rv item={i}>{c.premise}</Rv>
              </strong>
            </div>
            <ClaimText segments={c.explanation} onCite={onCite} citations={citations} item={i + 1} />
          </li>
        )
      })}
    </ul>
  )
}
