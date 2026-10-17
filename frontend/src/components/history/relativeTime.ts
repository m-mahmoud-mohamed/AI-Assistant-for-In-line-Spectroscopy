const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
]

/** "2 hours ago", "yesterday", "3 weeks ago"; "just now" under a minute; '' for an unparsable date. */
export function relativeDate(iso: string, now: Date = new Date(), locale?: string): string {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return ''
  const seconds = Math.round((then.getTime() - now.getTime()) / 1000)
  const abs = Math.abs(seconds)
  if (abs < 60) return 'just now'
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  for (const [unit, size] of UNITS) {
    if (abs >= size) return rtf.format(Math.round(seconds / size), unit)
  }
  return 'just now'
}
