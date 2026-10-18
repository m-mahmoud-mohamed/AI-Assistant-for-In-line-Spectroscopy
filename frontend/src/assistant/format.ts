// Small formatters for the assistant cards.
import type { ClarifyQuestion, QuestionAnswer } from '../types'

export const NOT_KNOWN_LABEL = 'Not known yet'
export const OTHER_LABEL = 'Other…'

/** What was answered, in words: the option label, "Not known yet", or the typed text. */
export function describeAnswer(question: ClarifyQuestion, answer: QuestionAnswer | undefined): string {
  if (!answer) return NOT_KNOWN_LABEL
  if ('unknown' in answer) return NOT_KNOWN_LABEL
  if ('other' in answer) return answer.other
  const label = (value: string) => question.options.find((o) => o.value === value)?.label ?? value
  return 'values' in answer ? answer.values.map(label).join(', ') : label(answer.value)
}

/** What a question changes, as a noun phrase ("Changes: primary method"); the report's question list prefixes "Changes:". */
export const IMPACT_NOTE: Record<ClarifyQuestion['impact'], string> = {
  STATUS_CHANGE: 'decision status',
  PRIMARY_METHOD_CHANGE: 'primary method',
  TECHNIQUE_CHANGE: 'technique',
  RISK_ONLY: 'risks only',
}

/** Human tool labels, including stored connector events from before titles were available. */
export function toolLabel(tool: string, label: string): string {
  const words = (value: string) => value.replace(/_+[a-f0-9]{8,}$/i, '').replace(/[._-]+/g, ' ').trim()
  if (tool.startsWith('mcp.')) {
    const old = /^Running (.+) on (.+)$/.exec(label)
    if (old) return `${words(old[2])} · ${words(old[1])}`
    if (label && label !== tool && !label.startsWith('mcp.')) return label.split(' · ').map(words).join(' · ')
    const [, server, ...name] = tool.split('.')
    return `${words(server || 'Server')} · ${words(name.join('.'))}`
  }
  return label && label !== tool ? label : words(tool) || 'Working…'
}
