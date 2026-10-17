import { labelOf, SCOPE_LABEL } from '../labels'
import { SuggestionChips } from './SuggestionChips'

interface RefusalCardProps {
  reason: string
  /** Scope label from the guard (OFF_TOPIC, UNSAFE, ...). */
  label?: string
  suggestions?: string[]
  /** Fills the composer with a suggested rephrasing. */
  onExample?: (text: string) => void
}

/** Shown when the scope guard refuses an enquiry or chat message: a muted heading, the reason, rephrasings. */
export function RefusalCard({ reason, label, suggestions = [], onExample }: RefusalCardProps) {
  return (
    <div role="alert" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2 className="section-title" style={{ color: 'var(--muted)', margin: 0 }}>
        Outside PRISM's scope
        {label && <span className="pill pill-info" style={{ fontWeight: 500 }}>{labelOf(SCOPE_LABEL, label)}</span>}
      </h2>
      <p style={{ margin: 0 }}>{reason || 'The request is outside what PRISM can assess.'}</p>
      {suggestions.length > 0 && onExample && (
        <>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>Try one of these instead:</p>
          <SuggestionChips suggestions={suggestions} onPick={onExample} label="Example enquiries" />
        </>
      )}
    </div>
  )
}
