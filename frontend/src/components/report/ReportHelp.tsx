import { useEffect, useId, useRef, useState } from 'react'
import { CircleHelp, X } from 'lucide-react'
import { useFocusTrap } from '../shell/useFocusTrap'
import { STATUS } from './status'

const STATUS_HELP: [keyof typeof STATUS, string][] = [
  ['PROVISIONAL', 'An initial recommendation. Confirm open facts and validate with representative samples.'],
  ['INSUFFICIENT_INFORMATION', 'Key facts are missing. Answer the clarification questions before choosing a method.'],
  ['OUTSIDE_SUPPORTED_SCOPE', 'Available evidence does not cover this request. Any concept is for screening only.'],
]

/** A short reading guide, available from every report tab. */
export function ReportHelp() {
  const [open, setOpen] = useState(false)
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  useFocusTrap(panel, open)
  useEffect(() => {
    if (!open) return
    const outside = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])

  return (
    <div ref={root} className="report-help" data-print-hide>
      <button type="button" className="link-btn" aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? id : undefined} onClick={() => setOpen((value) => !value)}>
        <CircleHelp size={15} aria-hidden="true" /> How to read this report
      </button>
      {open && (
        <div ref={panel} id={id} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} className="report-help-panel" onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            setOpen(false)
          }
        }}>
          <header>
            <h3 id={`${id}-title`}>How to read this report</h3>
            <button type="button" className="icon-square" aria-label="Close report help" onClick={() => setOpen(false)}><X size={16} aria-hidden="true" /></button>
          </header>
          <dl>
            {STATUS_HELP.map(([status, detail]) => <div key={status}><dt>{STATUS[status].label}</dt><dd>{detail}</dd></div>)}
            <div><dt>Verdict</dt><dd>Answers the client’s direct question: yes, no, conditional or not yet.</dd></div>
            <div><dt>Claims and citations</dt><dd>External: outside evidence. Assumption: confirm this fact. Unknown: missing information. Citation chips open source passages in Evidence. Unmarked proposals still need validation.</dd></div>
            <div><dt>Versions</dt><dd>Choose a version to revisit it; What changed compares its predecessor. Exports use the version on screen.</dd></div>
            <div><dt>Checks</dt><dd>Passing these checks does not establish scientific correctness. Review evidence scope, questions and the feasibility plan.</dd></div>
          </dl>
        </div>
      )}
    </div>
  )
}
