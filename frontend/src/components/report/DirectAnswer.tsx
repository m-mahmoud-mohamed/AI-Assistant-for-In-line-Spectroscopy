import { CircleCheck, CircleMinus, CircleSlash, CircleX, Clock, type LucideIcon } from 'lucide-react'
import type { DirectAnswer as DirectAnswerData, Verdict } from '../../types'
import { ClaimText } from './ClaimText'

const VERDICT: Record<Verdict, { label: string; icon: LucideIcon; tone: 'ok' | 'warn' | 'bad' | 'info' }> = {
  YES: { label: 'Yes', icon: CircleCheck, tone: 'ok' },
  NO: { label: 'No', icon: CircleX, tone: 'bad' },
  NOT_YET: { label: 'Not yet', icon: Clock, tone: 'warn' },
  CONDITIONAL: { label: 'Conditional', icon: CircleMinus, tone: 'warn' },
  NOT_APPLICABLE: { label: 'No yes/no question', icon: CircleSlash, tone: 'info' },
}

/** The direct answer's verdict as a tinted pill with an icon. */
export function VerdictPill({ verdict }: { verdict: Verdict }) {
  const { label, icon: Icon, tone } = VERDICT[verdict]
  return (
    <span className={`pill pill-${tone}`}>
      <Icon size={14} strokeWidth={2} aria-hidden="true" />
      <span className="sr-only">Verdict: </span>
      {label}
    </span>
  )
}

interface DirectAnswerProps {
  answer: DirectAnswerData
  onCite?: (cardId: string) => void
  citations?: Record<string, string>
  /** Reveal the words one by one, starting after this many ms (a fresh report). */
  revealDelay?: number
}

/** The direct answer in full: every claim-typed segment with its citation chips. */
export function DirectAnswer({ answer, onCite, citations, revealDelay }: DirectAnswerProps) {
  return <ClaimText segments={answer.text} onCite={onCite} citations={citations} reveal={revealDelay === undefined ? undefined : { delay: revealDelay }} />
}
