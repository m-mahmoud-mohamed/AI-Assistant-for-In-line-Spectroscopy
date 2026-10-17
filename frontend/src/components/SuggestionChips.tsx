interface SuggestionChipsProps {
  suggestions: string[]
  /** Called with the suggestion text; callers fill the composer with it (never auto-send). */
  onPick: (text: string) => void
  label?: string
}

/** Clickable follow-up prompts shown under answers, reports and refusals. */
export function SuggestionChips({ suggestions, onPick, label = 'Suggestions' }: SuggestionChipsProps) {
  if (suggestions.length === 0) return null
  return (
    <div role="group" aria-label={label} style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }} data-print-hide>
      {suggestions.map((s) => (
        <button key={s} type="button" className="chip" onClick={() => onPick(s)}>
          {s}
        </button>
      ))}
    </div>
  )
}
