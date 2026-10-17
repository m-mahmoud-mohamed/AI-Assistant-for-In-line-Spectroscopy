import { Lightbulb } from 'lucide-react'

interface SuggestionChipsProps {
  suggestions: string[]
  /** Called with the suggestion text; callers fill an input with it (never auto-send). */
  onPick: (text: string) => void
  label?: string
}

/** Clickable follow-up prompts shown under chat answers, reports and refusals. */
export function SuggestionChips({ suggestions, onPick, label = 'Suggestions' }: SuggestionChipsProps) {
  if (suggestions.length === 0) return null
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5" data-print-hide>
      {suggestions.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onPick(s)}
          className="inline-flex max-w-full items-center gap-1 rounded-full border border-line bg-surface-raised px-2.5 py-1 text-left text-xs hover:border-prism-500"
        >
          <Lightbulb size={12} aria-hidden="true" className="shrink-0 text-fiber-cyan" />
          <span>{s}</span>
        </button>
      ))}
    </div>
  )
}
