import { CircleCheck, CircleMinus, CircleSlash, CircleX, Clock, type LucideIcon } from 'lucide-react'
import type { DecisionStatus, DirectAnswer as DirectAnswerData, Verdict } from '../../types'
import { ClaimText } from './ClaimText'
import { StatusBanner } from './StatusBanner'
import { statusDetail } from './status'

const VERDICT: Record<Verdict, { label: string; icon: LucideIcon; tone: 'ok' | 'warn' | 'bad' | 'info' }> = {
  YES: { label: 'Yes', icon: CircleCheck, tone: 'ok' },
  NO: { label: 'No', icon: CircleX, tone: 'bad' },
  NOT_YET: { label: 'Not yet', icon: Clock, tone: 'warn' },
  CONDITIONAL: { label: 'Conditional', icon: CircleMinus, tone: 'warn' },
  NOT_APPLICABLE: { label: 'No yes/no question', icon: CircleSlash, tone: 'info' },
}

interface DirectAnswerProps {
  answer: DirectAnswerData
  status?: DecisionStatus
  onCite?: (cardId: string) => void
  citations?: Record<string, string>
}

/** Decision-status pill and verdict pill, then the direct answer paragraph (the enquiry bubble above already shows the question). */
export function DirectAnswer({ answer, status, onCite, citations }: DirectAnswerProps) {
  const { label, icon: Icon, tone } = VERDICT[answer.verdict]
  return (
    <section className="rs-sec rs-lead" aria-labelledby="direct-answer-heading">
      <h3 id="direct-answer-heading" className="sr-only">
        Direct answer
      </h3>
      <div className="rs-pills">
        {status && <StatusBanner status={status} />}
        <span className={`pill pill-${tone}`}>
          <Icon size={14} strokeWidth={2} aria-hidden="true" />
          <span className="sr-only">Verdict: </span>
          {label}
        </span>
      </div>
      {status && <p className="rs-status-note">{statusDetail(status)}</p>}
      <ClaimText segments={answer.text} onCite={onCite} citations={citations} item={1} />
    </section>
  )
}
