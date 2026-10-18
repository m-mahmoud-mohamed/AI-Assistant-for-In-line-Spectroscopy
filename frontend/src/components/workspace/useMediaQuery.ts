import { useCallback, useSyncExternalStore } from 'react'

/** Tracks a CSS media query. Where `matchMedia` does not exist (a bare test DOM) the `fallback` is used. */
export function useMediaQuery(query: string, fallback: boolean): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {}
      const mq = window.matchMedia(query)
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    },
    [query],
  )
  const snapshot = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : fallback)
  return useSyncExternalStore(subscribe, snapshot, () => fallback)
}
