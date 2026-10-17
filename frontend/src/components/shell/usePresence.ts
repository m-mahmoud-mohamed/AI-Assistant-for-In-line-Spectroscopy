import { useEffect, useState } from 'react'

/**
 * Keeps an element mounted for `exitMs` after `open` turns false so its exit animation can play.
 * `leaving` is true during that window (mark the element `inert` / `aria-hidden` while it is).
 */
export function usePresence(open: boolean, exitMs: number) {
  const [mounted, setMounted] = useState(open)
  if (open && !mounted) setMounted(true)
  useEffect(() => {
    if (open || !mounted) return
    const t = setTimeout(() => setMounted(false), exitMs)
    return () => clearTimeout(t)
  }, [open, mounted, exitMs])
  return { mounted: open || mounted, leaving: !open && mounted }
}
