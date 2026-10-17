import { forwardRef, useId } from 'react'
import { Play } from 'lucide-react'

interface EnquiryEditorProps {
  value: string
  onChange: (text: string) => void
  onSubmit: (text: string) => void
  busy?: boolean
  error?: string | null
}

/** Free-text customer enquiry; the text is sent verbatim to `POST /api/sessions`. */
export const EnquiryEditor = forwardRef<HTMLTextAreaElement, EnquiryEditorProps>(function EnquiryEditor(
  { value, onChange, onSubmit, busy, error },
  ref,
) {
  const id = useId()
  const canSubmit = value.trim().length > 0 && !busy
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (canSubmit) onSubmit(value)
      }}
    >
      <label htmlFor={id} className="text-sm font-bold">
        Enquiry
      </label>
      <textarea
        id={id}
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSubmit) {
            e.preventDefault()
            onSubmit(value)
          }
        }}
        rows={8}
        placeholder="Paste the customer's enquiry as received."
        className="w-full rounded-md border border-line bg-surface p-3 text-sm outline-none focus:border-prism-500"
      />
      {error && (
        <p role="alert" className="text-sm" style={{ color: 'var(--status-bad)' }}>
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted">⌘/Ctrl + Enter to start</span>
        <button
          type="submit"
          disabled={!canSubmit}
          className="inline-flex h-9 items-center gap-2 rounded-md bg-prism-600 px-4 text-sm font-semibold text-white hover:bg-prism-500 disabled:opacity-50"
        >
          <Play size={14} aria-hidden="true" /> {busy ? 'Starting…' : 'Start assessment'}
        </button>
      </div>
    </form>
  )
})
