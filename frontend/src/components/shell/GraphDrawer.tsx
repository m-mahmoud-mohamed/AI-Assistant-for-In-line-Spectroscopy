import { useEffect, useId, useRef } from 'react'
import { X } from 'lucide-react'
import type { PipelineState } from '../../pipeline/reducer'
import type { Stage } from '../../types'
import { PipelineGraph } from '../PipelineGraph'

interface GraphDrawerProps {
  open: boolean
  state: PipelineState
  selected: Stage | null
  onSelect: (stage: Stage) => void
  onClose: () => void
}

/** The full React Flow pipeline graph in a right drawer (opened from the thread or the rail). */
export function GraphDrawer({ open, state, selected, onSelect, onClose }: GraphDrawerProps) {
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    return () => previous?.focus?.()
  }, [open])
  if (!open) return null
  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" data-print-hide />
      <aside
        role="dialog"
        aria-labelledby={titleId}
        className="drawer"
        data-print-hide
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !selected) onClose()
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <h2 id={titleId} style={{ margin: 0, fontSize: 17, fontWeight: 500, color: 'var(--ink)' }}>
            Pipeline graph
          </h2>
          <button ref={closeRef} type="button" className="icon-square" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label="Close pipeline graph">
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
        <PipelineGraph state={state} selected={selected} onSelect={onSelect} />
      </aside>
    </>
  )
}
