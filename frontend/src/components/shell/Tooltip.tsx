import { useEffect, useRef, useState, type ReactNode } from 'react'

/** When any tooltip last closed: a neighbour opened within this window shows at once, with no animation. */
let lastClosed = 0
const WARM_MS = 300
const DELAY_MS = 400

/** True when focus came from the keyboard (:focus-visible); engines that lack the selector count as keyboard. */
function keyboardFocus(el: EventTarget): boolean {
  try {
    return (el as Element).matches(':focus-visible')
  } catch {
    return true
  }
}

interface TooltipProps {
  label: ReactNode
  children: ReactNode
  side?: 'right' | 'top'
}

/**
 * Hover / keyboard-focus tooltip. The first one waits 400 ms; once one has been open, moving to the next
 * opens it instantly (no delay, no animation). Hidden on touch pointers and below 760 px (see panel.css).
 */
export function Tooltip({ label, children, side = 'right' }: TooltipProps) {
  const [open, setOpen] = useState(false)
  const [instant, setInstant] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const isOpen = useRef(false)

  const set = (v: boolean) => {
    isOpen.current = v
    setOpen(v)
  }
  const show = (immediate: boolean) => {
    clearTimeout(timer.current)
    if (immediate || Date.now() - lastClosed < WARM_MS) {
      setInstant(true)
      set(true)
    } else {
      timer.current = setTimeout(() => {
        setInstant(false)
        set(true)
      }, DELAY_MS)
    }
  }
  const hide = () => {
    clearTimeout(timer.current)
    if (isOpen.current) lastClosed = Date.now()
    set(false)
  }
  useEffect(() => () => clearTimeout(timer.current), [])

  return (
    <span
      className="tt"
      onPointerEnter={(e) => e.pointerType !== 'touch' && show(false)}
      onPointerLeave={hide}
      onFocus={(e) => keyboardFocus(e.target) && show(true)}
      onBlur={hide}
      onKeyDown={(e) => e.key === 'Escape' && hide()}
    >
      {children}
      {open && (
        <span role="tooltip" className="tt-bubble" data-side={side} data-instant={instant}>
          {label}
        </span>
      )}
    </span>
  )
}
