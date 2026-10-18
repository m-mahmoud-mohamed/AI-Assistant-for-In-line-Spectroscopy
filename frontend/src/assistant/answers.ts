// What a scientist has picked in a question card, and the answer payload it stands for (CONTRACTS C4:
// `{value} | {values} | {unknown: true} | {other}` per question id).
import type { ClarifyQuestion, QuestionAnswer } from '../types'

/** What is picked for one question: option values, "not known yet", or free text under "Other…". */
export interface Choice {
  values: string[]
  unknown: boolean
  other: boolean
  otherText: string
}

export const EMPTY_CHOICE: Choice = { values: [], unknown: false, other: false, otherText: '' }
/** Keys of the two options the UI adds to every question. */
export const UNKNOWN_KEY = '__unknown'
export const OTHER_KEY = '__other'

/** The option keys of a question in display order: its own values, then "Not known yet" and "Other…". */
export const optionKeys = (q: ClarifyQuestion): string[] => [...q.options.map((o) => o.value), UNKNOWN_KEY, OTHER_KEY]

/** The choice after picking `key`: a single question replaces, a multi question toggles; "not known" and "Other…" stand alone. */
export function nextChoice(q: ClarifyQuestion, cur: Choice | undefined, key: string): Choice {
  const c = cur ?? EMPTY_CHOICE
  if (key === UNKNOWN_KEY) return { ...EMPTY_CHOICE, unknown: true }
  if (key === OTHER_KEY) return { ...EMPTY_CHOICE, other: true, otherText: c.otherText }
  if (q.multi) return { ...EMPTY_CHOICE, values: c.values.includes(key) ? c.values.filter((v) => v !== key) : [...c.values, key] }
  return { ...EMPTY_CHOICE, values: [key] }
}

/** The answer a choice stands for, or null while nothing (or an empty "Other…") is picked. */
export function choiceToAnswer(q: ClarifyQuestion, choice: Choice | undefined): QuestionAnswer | null {
  if (!choice) return null
  if (choice.unknown) return { unknown: true }
  if (choice.other) return choice.otherText.trim() ? { other: choice.otherText.trim() } : null
  if (choice.values.length === 0) return null
  return q.multi ? { values: choice.values } : { value: choice.values[0] }
}

/** Every question answered: what was picked, and "not known yet" for what was not (nothing is left unsaid). */
export function completeAnswers(questions: ClarifyQuestion[], choices: Record<string, Choice>): Record<string, QuestionAnswer> {
  return Object.fromEntries(questions.map((q) => [q.id, choiceToAnswer(q, choices[q.id]) ?? ({ unknown: true } as QuestionAnswer)]))
}

/** Skip all: every question stays unknown (and goes to the report as a question for the client). */
export const skipAnswers = (questions: ClarifyQuestion[]): Record<string, QuestionAnswer> => completeAnswers(questions, {})
