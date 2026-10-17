import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

export interface RectLike {
  left: number
  top: number
  width: number
  height: number
}

export interface FlipDelta {
  dx: number
  dy: number
}

/** Translation that moves an element laid out at `last` back to where it was at `first` (pure). */
export function flipDelta(first: RectLike, last: RectLike): FlipDelta {
  return { dx: first.left - last.left, dy: first.top - last.top }
}

export const EASE_IN_OUT = 'cubic-bezier(0.77, 0, 0.175, 1)'

/**
 * FLIP: animate `el` (already at its new layout position, `last`) from `first` with the Web Animations API.
 * Returns the Animation, or null when nothing moves or WAAPI is unavailable (jsdom, reduced motion).
 */
export function playFlip(
  el: HTMLElement,
  first: RectLike,
  last: RectLike,
  { duration = 520, easing = EASE_IN_OUT, reduced = false }: { duration?: number; easing?: string; reduced?: boolean } = {},
): Animation | null {
  const { dx, dy } = flipDelta(first, last)
  if (reduced || typeof el.animate !== 'function' || (Math.abs(dx) < 1 && Math.abs(dy) < 1)) return null
  return el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], {
    duration,
    easing,
    fill: 'backwards',
  })
}

/**
 * Glide `ref`'s element whenever `key` changes. The "first" rect is the one measured after the previous commit
 * (kept fresh on resize), the "last" rect is measured in the layout effect of the commit that moved it.
 * Nothing is animated on the first render.
 */
export function useFlip(ref: RefObject<HTMLElement | null>, key: unknown, options: { duration?: number; reduced?: boolean } = {}) {
  const prevKey = useRef(key)
  const lastRect = useRef<RectLike | null>(null)
  const { duration, reduced } = options

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const now = el.getBoundingClientRect()
    if (prevKey.current !== key) {
      prevKey.current = key
      if (lastRect.current) playFlip(el, lastRect.current, now, { duration, reduced })
    }
    lastRect.current = now
  })

  useEffect(() => {
    const refresh = () => {
      if (ref.current) lastRect.current = ref.current.getBoundingClientRect()
    }
    window.addEventListener('resize', refresh)
    return () => window.removeEventListener('resize', refresh)
  }, [ref])
}
