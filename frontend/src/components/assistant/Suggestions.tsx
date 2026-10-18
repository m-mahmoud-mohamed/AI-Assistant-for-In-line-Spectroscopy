import type { Suggestion } from '../../types'

interface SuggestionsProps {
  options: Suggestion[]
  onPick: (option: Suggestion) => void
  disabled?: boolean
}

/** Clickable next steps from a `suggestions` event; a click sends `{action, payload}` as the next turn. */
export function Suggestions({ options, onPick, disabled = false }: SuggestionsProps) {
  if (options.length === 0) return null
  return (
    <div role="group" aria-label="Next steps" className="as-next" data-print-hide>
      <span className="as-next-label">Next</span>
      {options.map((o) => (
        <button key={`${o.action}|${o.label}`} type="button" className="chip as-chip" disabled={disabled} onClick={() => onPick(o)}>
          {o.label.replaceAll('e-mail', 'e‑mail')}
        </button>
      ))}
    </div>
  )
}
