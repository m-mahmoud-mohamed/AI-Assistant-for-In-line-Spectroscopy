import { useEffect, useState } from 'react'
import { Check, Copy, Mail } from 'lucide-react'
import { QuestionsList } from '../../report/QuestionsList'
import { SectionSkeleton } from '../TabSection'
import type { TabProps } from './types'

/** The clarification questions in the order that matters, with what each one changes; copy them all or take one into the follow-up box. */
export function QuestionsTab({ assessment: a, model }: TabProps) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(model.questions.map((q, i) => `${i + 1}. ${q.question}`).join('\n'))
      setCopied(true)
    } catch {
      // clipboard unavailable: the e-mail draft carries the same questions
    }
  }

  if (model.pending.questions) return <SectionSkeleton label="questions" rows={6} />
  if (model.questions.length === 0) return <p className="rs-muted">No clarification questions: nothing open blocks the assessment.</p>
  return (
    <div className="tab-stack">
      <div className="qt-bar" data-print-hide>
        <p className="rs-muted">
          {model.questions.length} {model.questions.length === 1 ? 'question' : 'questions'}, most decisive first.
        </p>
        <div className="qt-actions">
          <button type="button" className="btn btn-sm" onClick={() => void copyAll()} aria-live="polite">
            {copied ? <Check size={16} strokeWidth={1.75} aria-hidden="true" /> : <Copy size={16} strokeWidth={1.75} aria-hidden="true" />}
            {copied ? 'Copied' : 'Copy all questions'}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => a.setEmailOpen(true)}>
            <Mail size={16} strokeWidth={1.75} aria-hidden="true" />
            Ask in e-mail draft
          </button>
        </div>
      </div>
      <QuestionsList questions={model.questions} onUse={a.fillQuestion} />
    </div>
  )
}
