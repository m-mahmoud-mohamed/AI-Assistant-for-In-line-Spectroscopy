import { GitBranch } from 'lucide-react'
import type { Question } from '../../types'
import { Rv } from './reveal'

interface QuestionsListProps {
  questions: Question[]
  /** Show only the first N questions after sorting. */
  limit?: number
}

/** Clarification questions, highest priority (1) first, each with the decision it changes. */
export function QuestionsList({ questions, limit }: QuestionsListProps) {
  const sorted = [...questions].sort((a, b) => a.priority - b.priority).slice(0, limit)
  if (sorted.length === 0) return <p className="rs-muted">No clarification questions.</p>
  return (
    <ol className="rs-list rs-questions">
      {sorted.map((q, i) => (
        <li key={i}>
          <div className="rs-q-head">
            <h4 className="rs-strong">
              <Rv item={i}>{q.question}</Rv>
            </h4>
            <span className="rs-prio tabular" aria-label={`Priority ${q.priority}`}>
              P{q.priority}
            </span>
          </div>
          <p className="rs-changes">
            <GitBranch size={12} strokeWidth={2} aria-hidden="true" />
            Changes: {q.decision_it_changes}
          </p>
          <p className="rs-muted">
            <Rv item={i + 1}>{q.why_it_matters}</Rv>
          </p>
        </li>
      ))}
    </ol>
  )
}
