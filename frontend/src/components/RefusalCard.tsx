import { Ban } from 'lucide-react'
import { SCOPE_LABEL, labelOf } from '../labels'
import { SuggestionChips } from './SuggestionChips'

interface RefusalCardProps {
  reason: string
  /** Scope label from the guard (OFF_TOPIC, UNSAFE, ...). */
  label?: string
  suggestions?: string[]
  /** Fills the enquiry editor (or chat input) with an example. */
  onExample?: (text: string) => void
}

/** Shown when the scope guard refuses an enquiry or chat message: reason plus example rephrasings. */
export function RefusalCard({ reason, label, suggestions = [], onExample }: RefusalCardProps) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-lg border p-4"
      style={{ borderColor: 'var(--fiber-magenta)', background: 'color-mix(in srgb, var(--fiber-magenta) 8%, transparent)' }}
    >
      <p className="flex items-center gap-2 text-sm font-bold">
        <Ban size={16} aria-hidden="true" style={{ color: 'var(--fiber-magenta)' }} />
        Not assessed{label ? ` · ${labelOf(SCOPE_LABEL, label)}` : ''}
      </p>
      <p className="text-sm">{reason || 'The request is outside what PRISM can assess.'}</p>
      {suggestions.length > 0 && onExample && (
        <>
          <p className="text-xs text-muted">Try one of these instead:</p>
          <SuggestionChips suggestions={suggestions} onPick={onExample} label="Example enquiries" />
        </>
      )}
    </div>
  )
}
