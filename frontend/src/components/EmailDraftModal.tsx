import { useEffect, useId, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, Copy, Download, Mail, X } from 'lucide-react'
import { api } from '../api'
import { Skeleton } from '../motion'
import { downloadText, localEmailDraft } from '../export'
import type { ReportViewData } from '../types'
import { useFocusTrap } from './shell/useFocusTrap'
import { usePresence } from './shell/usePresence'
import './panel/panel.css'

interface EmailDraftModalProps {
  open: boolean
  sessionId: string | null
  /** Run the draft belongs to (cache key); the backend drafts from the session's latest report. */
  runId?: string | null
  report: ReportViewData
  onClose: () => void
}

function DraftBody({ sessionId, runId, report, onClose, leaving }: Omit<EmailDraftModalProps, 'open'> & { leaving: boolean }) {
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
  useFocusTrap(dialogRef, !leaving)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      textRef.current?.select()
    }
  }

  return (
    <div className="ov-modal-scrim" data-leaving={leaving || undefined} aria-hidden={leaving || undefined} data-print-hide>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="ov-modal"
        data-wide
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onClose()
          }
        }}
      >
        <header className="ov-head">
          <div style={{ minWidth: 0 }}>
            <h2 id={titleId} className="ov-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Mail size={18} strokeWidth={1.75} aria-hidden="true" style={{ color: 'var(--violet)' }} /> Customer e-mail draft
            </h2>
            <p className="ov-sub" aria-live="polite">
              {draft.isPending
                ? 'Drafting…'
                : local
                  ? "PRISM's API is not reachable: draft generated locally from the open clarification questions."
                  : 'Drafted from the current report. Review before sending; it asks only the open questions.'}
            </p>
          </div>
          <button type="button" className="icon-square" onClick={onClose} aria-label="Close">
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </header>
        <label htmlFor={textId} className="sr-only">
          E-mail text
        </label>
        {draft.isPending && !edited && (
          <div role="status" aria-label="Drafting" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}>
            <Skeleton height={14} width="40%" />
            <Skeleton height={14} />
            <Skeleton height={14} width="86%" />
          </div>
        )}
        <textarea id={textId} ref={textRef} data-autofocus value={text} onChange={(e) => setEdited(e.target.value)} rows={14} className="ov-textarea" />
        <footer className="ov-foot">
          <button type="button" className="btn" onClick={() => downloadText('prism-email-draft.txt', text, 'text/plain;charset=utf-8')} disabled={!text}>
            <Download size={16} strokeWidth={1.75} aria-hidden="true" /> Download .txt
          </button>
          <button type="button" className="btn btn-primary" onClick={copy} disabled={!text}>
            {copied ? <Check size={16} strokeWidth={2} aria-hidden="true" /> : <Copy size={16} strokeWidth={1.75} aria-hidden="true" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </footer>
      </div>
    </div>
  )
}

/** Client-facing e-mail asking the open questions (`POST /api/sessions/{id}/email-draft`). */
export function EmailDraftModal({ open, ...rest }: EmailDraftModalProps) {
  const { mounted, leaving } = usePresence(open, 120)
  if (!mounted) return null
  return <DraftBody {...rest} leaving={leaving} />
}
