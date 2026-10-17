import { useContext, useId, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { ExpandAllContext } from './revealState'

/** "Show more" toggle button; hidden when printing, where everything is expanded. */
function MoreButton({
  open,
  onToggle,
  controls,
  label,
  keepLabel = false,
}: {
  open: boolean
  onToggle: () => void
  controls: string
  label: ReactNode
  /** Keep the label when open instead of switching to "Show less" (footer toggles). */
  keepLabel?: boolean
}) {
  return (
    <button type="button" className="rs-more-btn" aria-expanded={open} aria-controls={controls} onClick={onToggle} data-print-hide>
      {open && !keepLabel ? 'Show less' : label}
      <ChevronDown size={14} strokeWidth={2} aria-hidden="true" data-open={open ? 'true' : undefined} />
    </button>
  )
}

/**
 * Extra content behind a button (never a tab). `more` (default): the content opens above the button, which
 * then reads "Show less". `toggle`: the label stays and the content opens below it (the footer toggles).
 */
export function Disclosure({ label, children, variant = 'more' }: { label: ReactNode; children: ReactNode; variant?: 'more' | 'toggle' }) {
  const all = useContext(ExpandAllContext)
  const [open, setOpen] = useState(false)
  const id = useId()
  const shown = open || all
  const body = shown && (
    <div id={id} className="rs-more-body">
      {children}
    </div>
  )
  const button = <MoreButton open={shown} onToggle={() => setOpen((o) => !o)} controls={id} label={label} keepLabel={variant === 'toggle'} />
  return (
    <div className="rs-more" data-variant={variant}>
      {variant === 'toggle' ? (
        <>
          {button}
          {body}
        </>
      ) : (
        <>
          {body}
          {button}
        </>
      )}
    </div>
  )
}

interface MoreListProps {
  items: ReactNode[]
  /** How many items show before the button. */
  limit: number
  /** What the hidden items are, e.g. "recommendations" → "Show 3 more recommendations". */
  noun: string
  ordered?: boolean
  className?: string
}

/** A bullet or numbered list that shows its first `limit` items and the rest on demand. */
export function MoreList({ items, limit, noun, ordered = false, className = 'rs-list' }: MoreListProps) {
  const all = useContext(ExpandAllContext)
  const [open, setOpen] = useState(false)
  const id = useId()
  const Tag = ordered ? 'ol' : 'ul'
  const hidden = items.length - limit
  const shown = open || all || hidden <= 0 ? items : items.slice(0, limit)
  return (
    <>
      <Tag id={id} className={className}>
        {shown}
      </Tag>
      {hidden > 0 && !all && <MoreButton open={open} onToggle={() => setOpen((o) => !o)} controls={id} label={`Show ${hidden} more ${noun}`} />}
    </>
  )
}
