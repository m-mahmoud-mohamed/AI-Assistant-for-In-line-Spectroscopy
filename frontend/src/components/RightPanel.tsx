import type { ReactNode } from 'react'
import { BookOpen, ChevronDown, ChevronUp, MessageSquare } from 'lucide-react'

interface RightPanelProps {
  open: boolean
  onToggle: () => void
  /** Evidence viewer for the selected citation; a hint when nothing is selected. */
  evidence?: ReactNode
  /** Chat panel for the current session. */
  chat?: ReactNode
}

/** Evidence viewer + chat. Desktop: right column. Narrow widths: bottom sheet (see theme.css). */
export function RightPanel({ open, onToggle, evidence, chat }: RightPanelProps) {
  return (
    <aside id="right-panel" className="app-panel flex flex-col" data-open={open} aria-label="Evidence and chat">
      <button
        type="button"
        onClick={onToggle}
        className="narrow-only h-12 w-full shrink-0 items-center justify-center gap-2 border-b border-line text-sm font-semibold"
        aria-expanded={open}
        aria-controls="right-panel"
      >
        {open ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronUp size={16} aria-hidden="true" />}
        Evidence / Chat
      </button>

      <section className="max-h-[55%] shrink-0 overflow-y-auto border-b border-line p-4" aria-labelledby="evidence-heading">
        <h2
          id="evidence-heading"
          className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.16em] text-muted"
        >
          <BookOpen size={14} aria-hidden="true" /> Evidence
        </h2>
        {evidence ?? (
          <p className="text-sm text-muted">Select a citation in the report to see its source page and verbatim quote.</p>
        )}
      </section>

      <section className="flex min-h-0 flex-1 flex-col p-4" aria-labelledby="chat-heading">
        <h2
          id="chat-heading"
          className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.16em] text-muted"
        >
          <MessageSquare size={14} aria-hidden="true" /> Chat
        </h2>
        {chat ?? (
          <p className="text-sm text-muted">Answer a clarification question or add client information to start a new version.</p>
        )}
      </section>
    </aside>
  )
}
