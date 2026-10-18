import { useContext, useId, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { ExpandAllContext } from './expandAll'

interface DisclosureRowProps {
  /** Id of the heading (the section's `aria-labelledby`). */
  id: string
  label: ReactNode
  /** One line shown beside the label while the row is closed. */
  summary: string
  children: ReactNode
}

/**
 * A one-line disclosure: label, a one-line summary and a chevron; the body opens below it (grid rows 0fr → 1fr,
 * 220 ms ease-out, instant under reduced motion). Printing opens every row. The body mounts on first open.
 */
export function DisclosureRow({ id, label, summary, children }: DisclosureRowProps) {
  const all = useContext(ExpandAllContext)
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const bodyId = useId()
  const shown = open || all
  const toggle = () => {
    setMounted(true)
    setOpen((o) => !o)
  }
  return (
    <>
      <h3 id={id} className="rs-label rs-row-head">
        <button type="button" className="rs-row-btn" aria-expanded={shown} aria-controls={bodyId} onClick={toggle}>
          <span className="rs-row-label">{label}</span>
          <span className="rs-row-summary" aria-hidden={shown ? 'true' : undefined}>
            {summary}
          </span>
          <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" data-open={shown ? 'true' : undefined} />
        </button>
      </h3>
      <div id={bodyId} className="rs-row-body" data-open={shown ? 'true' : 'false'} inert={!shown}>
        <div className="rs-row-clip">
          <div className="rs-row-inner">{(mounted || shown) && children}</div>
        </div>
      </div>
    </>
  )
}
