// Follow-up prompts for the chat, derived only from what the report already contains
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
