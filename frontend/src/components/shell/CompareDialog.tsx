import { useEffect, useId, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { api } from '../../api'
import { Skeleton } from '../../motion'
import { DiffView } from '../DiffView'
import { usePresence } from './usePresence'
import { useFocusTrap } from './useFocusTrap'
import '../panel/panel.css'

interface CompareDialogProps {
  open: boolean
  sessionId: string | null
  from: number | null
  to: number | null
  onClose: () => void
}

function Body({ sessionId, from, to, onClose, leaving }: Omit<CompareDialogProps, 'open'> & { leaving: boolean }) {
  const titleId = useId()
  const ref = useRef<HTMLDivElement>(null)
  const diff = useQuery({
    queryKey: ['diff', sessionId, from, to],
    queryFn: () => api.getDiff(sessionId!, from!, to!),
    enabled: !!sessionId && from !== null && to !== null,
    retry: false,
  })
  useFocusTrap(ref, !leaving)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="ov-modal-scrim"
      data-leaving={leaving || undefined}
      aria-hidden={leaving || undefined}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      data-print-hide
    >
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className="ov-modal" data-wide>
        <header className="ov-head">
          <h2 id={titleId} className="ov-title">
            Report v{from} → v{to}
          </h2>
          <button type="button" className="icon-square" onClick={onClose} aria-label="Close comparison">
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </header>
        <div className="ov-body" aria-live="polite">
          {diff.isPending && (
            <div role="status" aria-label="Loading changes; please wait" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Skeleton height={16} width="45%" />
              <Skeleton height={44} radius={10} />
              <Skeleton height={44} radius={10} />
            </div>
          )}
          {diff.isError && <p className="inline-error">The changes could not be loaded. Retry the comparison; contact your PRISM administrator if it still fails. <button type="button" className="link-btn" onClick={() => void diff.refetch()}>Retry comparison</button></p>}
          {diff.data && from !== null && to !== null && <DiffView diff={diff.data} from={from} to={to} />}
        </div>
      </div>
    </div>
  )
}

/** "Compare with previous": the DiffView for two report versions of the session, in a centred modal. */
export function CompareDialog({ open, ...rest }: CompareDialogProps) {
  const { mounted, leaving } = usePresence(open, 120)
  return mounted ? <Body {...rest} leaving={leaving} /> : null
}
