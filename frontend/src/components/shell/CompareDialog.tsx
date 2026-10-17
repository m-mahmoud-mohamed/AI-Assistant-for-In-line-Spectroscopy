import { useEffect, useId, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { api } from '../../api'
import { DiffView } from '../DiffView'

interface CompareDialogProps {
  open: boolean
  sessionId: string | null
  from: number | null
  to: number | null
  onClose: () => void
}

function Body({ sessionId, from, to, onClose }: Omit<CompareDialogProps, 'open'>) {
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const diff = useQuery({
    queryKey: ['diff', sessionId, from, to],
    queryFn: () => api.getDiff(sessionId!, from!, to!),
    enabled: !!sessionId && from !== null && to !== null,
    retry: false,
  })

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    return () => previous?.focus?.()
  }, [])

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()} data-print-hide>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="modal"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onClose()
          }
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <h2 id={titleId} style={{ margin: 0, fontSize: 17, fontWeight: 500, color: 'var(--ink)' }}>
            Report v{from} → v{to}
          </h2>
          <button ref={closeRef} type="button" className="icon-square" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label="Close comparison">
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
        <div style={{ overflowY: 'auto' }} aria-live="polite">
          {diff.isPending && <p style={{ margin: 0, fontSize: 14 }}>Loading changes…</p>}
          {diff.isError && <p style={{ margin: 0, fontSize: 14, color: 'var(--status-bad)' }}>The changes could not be loaded.</p>}
          {diff.data && from !== null && to !== null && <DiffView diff={diff.data} from={from} to={to} />}
        </div>
      </div>
    </div>
  )
}

/** "Compare with previous": the existing DiffView for two report versions of the session. */
export function CompareDialog({ open, ...rest }: CompareDialogProps) {
  return open ? <Body {...rest} /> : null
}
