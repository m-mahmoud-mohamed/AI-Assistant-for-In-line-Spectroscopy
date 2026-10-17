// Pure helpers behind RevealWords and the greeting.

export interface WordToken {
  /** A word, or a run of whitespace (`isSpace`). */
  text: string
  isSpace: boolean
}

/** Split text into words and whitespace runs, keeping both so the text can be rebuilt exactly. */
export function tokenize(text: string): WordToken[] {
  return text
    .split(/(\s+)/)
    .filter((t) => t.length > 0)
    .map((t) => ({ text: t, isSpace: /^\s+$/.test(t) }))
}

export const countWords = (text: string): number => tokenize(text).filter((t) => !t.isSpace).length

/**
 * Delay (ms) of word `index` out of `count`: `stagger` apart, but the delay of the last word never
 * exceeds `cap` (the total reveal of a long paragraph stays bounded).
 */
export function wordDelay(index: number, count: number, stagger: number, cap?: number): number {
  if (count <= 1) return 0
  const step = cap === undefined ? stagger : Math.min(stagger, cap / (count - 1))
  return Math.round(index * step * 100) / 100
}

export type DayPart = 'morning' | 'afternoon' | 'evening'

/** Time-of-day greeting word: before 12 morning, before 18 afternoon, else evening. */
export function dayPart(date: Date = new Date()): DayPart {
  const h = date.getHours()
  return h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'
}

export const greetingFor = (date: Date = new Date()): string => `Good ${dayPart(date)}.`

/** The home greeting: a time-of-day first line and a second line whose last words carry the emphasis. */
export function greetingLines(date: Date = new Date()): { first: string; second: string; emphasis: string } {
  return { first: greetingFor(date), second: 'Which process should we', emphasis: 'look inside?' }
}
