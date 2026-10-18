import { GitBranch, MessageSquareReply } from 'lucide-react'
import { plainText } from '../../labels'
import type { Question } from '../../types'

interface QuestionsListProps {
  questions: Question[]
  /** Show only the first N questions after sorting. */
  limit?: number
  /** Adds a "Use as follow-up" action to each question (fills the composer, never sends). */
  onUse?: (question: string) => void
  /** Overview teaser: one line each, without the reason. */
  compact?: boolean
}

/** Clarification questions, highest priority (1) first, each with the decision it changes and why it matters. */
export function QuestionsList({ questions, limit, onUse, compact = false }: QuestionsListProps) {
  const sorted = [...questions].sort((a, b) => a.priority - b.priority).slice(0, limit)
  if (sorted.length === 0) return <p className="rs-muted">No clarification questions.</p>
  return (
    <ol className="ql" data-compact={compact ? 'true' : undefined}>
      {sorted.map((q, i) => (
        <li key={i} className="ql-item">
          <span className="rs-prio tabular" aria-label={`Priority ${q.priority}`}>
            P{q.priority}
          </span>
          <div className="ql-body">
            <h4 className="ql-q">{q.question}</h4>
            <p className="rs-changes">
              <GitBranch size={12} strokeWidth={2} aria-hidden="true" />
              Changes: {plainText(q.decision_it_changes)}
            </p>
            {!compact && <p className="rs-muted">{q.why_it_matters}</p>}
          </div>
          {onUse && !compact && (
            <button type="button" className="btn btn-sm ql-use" onClick={() => onUse(q.question)} aria-label={`Use as follow-up: ${q.question}`}>
              <MessageSquareReply size={14} strokeWidth={1.75} aria-hidden="true" />
              Use as follow-up
            </button>
          )}
        </li>
      ))}
    </ol>
  )
}
