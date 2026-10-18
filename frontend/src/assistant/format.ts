// Small formatters for the assistant cards.
import type { ClarifyQuestion, PreviewCandidate, QuestionAnswer } from '../types'

/** "3.1 s", "12 s", "<0.1 s"; null when there is no duration. */
export function formatDuration(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null
  if (seconds < 0.1) return '<0.1 s'
  return seconds < 10 ? `${seconds.toFixed(1)} s` : `${Math.round(seconds)} s`
}

/** A candidate score as the engine preview shows it: one decimal, none for a whole number. */
export const formatScore = (score: number): string => (Number.isInteger(score) ? String(score) : score.toFixed(1))

/** Candidates in the order a scientist reads them: the ones still open first, best score first. */
export const rankedCandidates = (candidates: readonly PreviewCandidate[]): PreviewCandidate[] =>
  [...candidates].sort((a, b) => Number(a.blocked) - Number(b.blocked) || b.score - a.score)

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
