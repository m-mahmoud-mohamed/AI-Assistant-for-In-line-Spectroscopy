import { CircleCheck, CircleMinus, CircleSlash, CircleX, Clock, type LucideIcon } from 'lucide-react'
import type { DirectAnswer as DirectAnswerData, Verdict } from '../../types'
import { ClaimText } from './ClaimText'

const VERDICT: Record<Verdict, { label: string; icon: LucideIcon; color: string }> = {
  YES: { label: 'Yes', icon: CircleCheck, color: 'var(--status-ok)' },
  NO: { label: 'No', icon: CircleX, color: 'var(--status-bad)' },
  NOT_YET: { label: 'Not yet', icon: Clock, color: 'var(--status-warn)' },
  CONDITIONAL: { label: 'Conditional', icon: CircleMinus, color: 'var(--status-warn)' },
  NOT_APPLICABLE: { label: 'No yes/no question', icon: CircleSlash, color: 'var(--text-muted)' },
}

interface DirectAnswerProps {
  answer: DirectAnswerData
  onCite?: (cardId: string) => void
  citations?: Record<string, string>
}

export function DirectAnswer({ answer, onCite, citations }: DirectAnswerProps) {
  const { label, icon: Icon, color } = VERDICT[answer.verdict]
  return (
    <section className="rounded-lg border border-line bg-surface p-4" aria-labelledby="direct-answer-heading">
      <h2 id="direct-answer-heading" className="mb-2 flex flex-wrap items-center gap-2 text-sm font-bold">
        Direct answer
        <span
          className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold"
          style={{ borderColor: color }}
        >
          <Icon size={12} aria-hidden="true" style={{ color }} />
          {label}
        </span>
      </h2>
      <ClaimText segments={answer.text} onCite={onCite} citations={citations} />
    </section>
  )
}
