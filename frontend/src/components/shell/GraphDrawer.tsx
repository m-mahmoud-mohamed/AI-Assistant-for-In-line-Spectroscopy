import { useEffect, useId, useRef } from 'react'
import { X } from 'lucide-react'
import type { PipelineState } from '../../pipeline/reducer'
import { formatSeconds, totalSeconds } from '../../pipeline/status'
import type { Stage } from '../../types'
import { PipelineGraph } from '../PipelineGraph'
import { usePresence } from './usePresence'
import { useFocusTrap } from './useFocusTrap'
import '../panel/panel.css'

interface GraphDrawerProps {
  open: boolean
  state: PipelineState
  selected: Stage | null
  onSelect: (stage: Stage) => void
  onClose: () => void
}

/**
 * The full React Flow pipeline graph in a right drawer (rail "Pipeline" and the thread's "View graph").
 * Slides in 260 ms ease-out, leaves in 160 ms; Esc closes it (a stage detail panel closes first); focus is trapped.
 */
export function GraphDrawer({ open, state, selected, onSelect, onClose }: GraphDrawerProps) {
  const titleId = useId()
  const ref = useRef<HTMLElement>(null)
  const { mounted, leaving } = usePresence(open, 160)
  useFocusTrap(ref, open && mounted)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !selected) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, selected, onClose])

  if (!mounted) return null
  const total = totalSeconds(state)
  return (
    <>
      <div className="ov-scrim" data-leaving={leaving || undefined} onClick={onClose} aria-hidden="true" data-print-hide />
      <aside
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-hidden={leaving || undefined}
        inert={leaving}
        className="ov-drawer"
        data-leaving={leaving || undefined}
        data-print-hide
      >
        <header className="ov-head">
          <div style={{ minWidth: 0 }}>
            <h2 id={titleId} className="ov-title">
              Pipeline graph
            </h2>
            {total !== null && <p className="ov-sub tabular">{formatSeconds(total)} in total</p>}
          </div>
          <button type="button" className="icon-square" onClick={onClose} aria-label="Close pipeline graph">
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </header>
        <PipelineGraph state={state} selected={selected} onSelect={onSelect} />
      </aside>
    </>
  )
}
