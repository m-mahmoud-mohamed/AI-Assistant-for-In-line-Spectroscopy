import { useEffect, type RefObject } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Open traps, innermost last: only the top one handles Tab, so a drawer over a drawer behaves. */
const stack: HTMLElement[] = []

/**
 * Keeps keyboard focus inside `ref` while `active`: focuses `[data-autofocus]` (or the first control) on open,
 * wraps Tab / Shift+Tab, and returns focus to the previously focused element on close.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    const root = ref.current
    if (!active || !root) return
    const previous = document.activeElement as HTMLElement | null
    stack.push(root)
    const items = () => Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
    const first = root.querySelector<HTMLElement>('[data-autofocus]') ?? items()[0] ?? root
    if (first === root && !root.hasAttribute('tabindex')) root.tabIndex = -1
    first.focus()

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || stack[stack.length - 1] !== root) return
      const list = items()
      if (list.length === 0) {
        e.preventDefault()
        return
      }
      const firstEl = list[0]
      const lastEl = list[list.length - 1]
      const current = document.activeElement
      if (!root.contains(current)) {
        e.preventDefault()
        firstEl.focus()
      } else if (e.shiftKey && current === firstEl) {
        e.preventDefault()
        lastEl.focus()
      } else if (!e.shiftKey && current === lastEl) {
        e.preventDefault()
        firstEl.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      const i = stack.lastIndexOf(root)
      if (i >= 0) stack.splice(i, 1)
      if (previous && document.contains(previous)) previous.focus?.()
    }
  }, [ref, active])
}
