import { useEffect, useId, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, Copy, Download, Mail, X } from 'lucide-react'
import { api } from '../api'
import { downloadText, localEmailDraft } from '../export'
import type { ReportViewData } from './report/ReportView'

interface EmailDraftModalProps {
  open: boolean
  sessionId: string | null
  /** Run the draft belongs to (cache key); the backend drafts from the session's latest report. */
  runId?: string | null
  report: ReportViewData
  onClose: () => void
}

function DraftBody({ sessionId, runId, report, onClose }: Omit<EmailDraftModalProps, 'open'>) {
  const titleId = useId()
  const textId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const [edited, setEdited] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const draft = useQuery({
    queryKey: ['email-draft', sessionId, runId ?? null],
    queryFn: async () => {
      if (!sessionId) throw new Error('no session')
      return (await api.emailDraft(sessionId)).text
    },
    retry: false,
    staleTime: Infinity,
  })
  const local = draft.isError
  const text = edited ?? (draft.data ?? (local ? localEmailDraft(report) : ''))

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    textRef.current?.focus()
    return () => previous?.focus?.()
  }, [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      textRef.current?.select()
    }
  }

  return (
    <div className="modal-scrim" data-print-hide>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="modal flex max-h-[90vh] w-full max-w-2xl flex-col gap-3"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onClose()
            return
          }
          if (e.key !== 'Tab' || !dialogRef.current) return
          // Keep focus inside the dialog.
          const focusable = dialogRef.current.querySelectorAll<HTMLElement>('button, textarea, [href]')
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault()
            last?.focus()
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault()
            first?.focus()
          }
        }}
      >
        <div className="flex items-center gap-2">
          <h2 id={titleId} className="flex items-center gap-2 text-sm font-bold">
            <Mail size={16} aria-hidden="true" className="text-fiber-cyan" /> Customer e-mail draft
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto rounded p-1 text-muted hover:text-fg">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <p className="text-xs text-muted" aria-live="polite">
          {draft.isPending
            ? 'Drafting…'
            : local
              ? "PRISM's API is not reachable: draft generated locally from the open clarification questions."
              : 'Drafted from the current report. Review before sending; it asks only the open questions.'}
        </p>
        <label htmlFor={textId} className="sr-only">
          E-mail text
        </label>
        <textarea
          id={textId}
          ref={textRef}
          value={text}
          onChange={(e) => setEdited(e.target.value)}
          rows={16}
          className="min-h-0 w-full flex-1 rounded-md border border-line bg-surface-raised p-3 font-mono text-xs outline-none focus:border-prism-500"
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => downloadText('prism-email-draft.txt', text, 'text/plain;charset=utf-8')}
            disabled={!text}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-line px-3 text-sm hover:bg-surface-raised disabled:opacity-50"
          >
            <Download size={14} aria-hidden="true" /> Download .txt
          </button>
          <button
            type="button"
            onClick={copy}
            disabled={!text}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-prism-600 px-3 text-sm font-semibold text-white hover:bg-prism-500 disabled:opacity-50"
          >
            {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Client-facing e-mail asking the open questions (`POST /api/sessions/{id}/email-draft`). */
export function EmailDraftModal({ open, ...rest }: EmailDraftModalProps) {
  if (!open) return null
  return <DraftBody {...rest} />
}
