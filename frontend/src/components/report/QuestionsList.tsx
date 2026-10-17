import { GitBranch } from 'lucide-react'
import type { Question } from '../../types'

interface QuestionsListProps {
  questions: Question[]
  /** Show only the first N questions after sorting (e.g. top 3 on the overview). */
  limit?: number
}

/** Clarification questions, highest priority (1) first, each with the decision it changes. */
export function QuestionsList({ questions, limit }: QuestionsListProps) {
  const sorted = [...questions].sort((a, b) => a.priority - b.priority).slice(0, limit)
  if (sorted.length === 0) return <p className="text-sm text-muted">No clarification questions.</p>
  return (
    <ol className="flex flex-col gap-3">
      {sorted.map((q, i) => (
        <li key={i} className="flex gap-3">
          <span
            className="mt-0.5 h-6 shrink-0 rounded bg-surface-raised px-1.5 font-mono text-xs leading-6"
            aria-label={`Priority ${q.priority}`}
          >
            P{q.priority}
          </span>
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold">{q.question}</h3>
            <span className="inline-flex w-fit items-center gap-1 rounded border border-line px-1.5 py-0.5 text-xs">
              <GitBranch size={11} aria-hidden="true" className="text-prism-500" />
              Changes: {q.decision_it_changes}
            </span>
            <p className="text-sm text-muted">{q.why_it_matters}</p>
          </div>
        </li>
      ))}
    </ol>
  )
}
