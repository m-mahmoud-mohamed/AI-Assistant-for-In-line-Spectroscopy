// Follow-up prompts, suggested tasks and questions, derived only from what the report already contains
// (method names, techniques, its own questions). No numbers or facts are added here.
import type { ReportBody } from './types'

const GENERIC = [
  'Which open question changes the recommendation most?',
  'Which sources support the primary method?',
  'What should the feasibility study show first?',
]

export function reportSuggestions(report?: Pick<ReportBody, 'recommendations' | 'clarification_questions'>, max = 4): string[] {
  if (!report) return GENERIC.slice(0, max)
  const out: string[] = []
  const lead = report.recommendations.find((r) => r.role === 'PRIMARY') ?? report.recommendations[0]
  if (lead) {
    const methods = lead.methods.join(' + ')
    out.push(`Why is ${methods} with a ${lead.technique} suggested?`)
    out.push(`Does the fiber link transmit the ${methods} range?`)
  }
  const top = [...report.clarification_questions].sort((a, b) => a.priority - b.priority)[0]
  if (top) out.push(`Why does the question “${top.question}” matter?`)
  out.push('Which sources support the recommendation?')
  for (const g of GENERIC) if (out.length < max && !out.includes(g)) out.push(g)
  return [...new Set(out)].slice(0, max)
}

/** What a suggested-task chip does when clicked. */
export type TaskAction = { kind: 'email' } | { kind: 'rerun-deep' } | { kind: 'fill'; text: string }

export interface SuggestedTask {
  id: string
  label: string
  action: TaskAction
}

/** Right-panel "Suggested tasks": chips that run an action or fill the composer. */
export function suggestedTasks(report?: Pick<ReportBody, 'recommendations'>): SuggestedTask[] {
  const methods = [...new Set((report?.recommendations ?? []).flatMap((r) => r.methods))]
  const tasks: SuggestedTask[] = [{ id: 'email', label: 'Draft the customer e-mail', action: { kind: 'email' } }]
  if (methods.length >= 2) {
    const pair = `${methods[0]} and ${methods[1]}`
    tasks.push({ id: 'compare', label: `Compare ${pair} here`, action: { kind: 'fill', text: `Compare ${pair} for this process.` } })
  }
  tasks.push({ id: 'deep', label: 'Re-run in deep mode', action: { kind: 'rerun-deep' } })
  tasks.push({
    id: 'status',
    label: 'Explain the decision status',
    action: { kind: 'fill', text: 'Explain the decision status of this assessment.' },
  })
  return tasks
}

/** The composer text a clarification question fills in: the user types the client's answer after it. */
export const questionDraft = (question: string): string => `Client answer to "${question}": `
