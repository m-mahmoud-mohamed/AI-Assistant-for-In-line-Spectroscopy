import { useEffect, useState } from 'react'
import { useReducedMotion } from './useReducedMotion'

/** The part of `text` typed after `elapsedMs` at `msPerChar` per character (pure; used by the hook and tests). */
export function typedSlice(text: string, elapsedMs: number, msPerChar: number): string {
  if (msPerChar <= 0) return text
  const n = Math.max(0, Math.min(text.length, Math.floor(elapsedMs / msPerChar)))
  return text.slice(0, n)
}

/**
 * Letter-by-letter typing of `text`; restarts from empty whenever `text` changes.
 * With reduced motion the whole text is returned at once.
 */
export function useTypewriter(text: string, msPerChar = 28): string {
  const reduced = useReducedMotion()
  const [state, setState] = useState({ text, count: 0 })
  // Restart synchronously when the text changes (no flash of the new text at full length).
  if (state.text !== text) setState({ text, count: 0 })

  useEffect(() => {
    if (reduced || !text) return
    const start = performance.now()
    const id = setInterval(() => {
      const count = typedSlice(text, performance.now() - start, msPerChar).length
      setState((s) => (s.text === text && s.count !== count ? { text, count } : s))
      if (count >= text.length) clearInterval(id)
    }, Math.max(8, msPerChar / 2))
    return () => clearInterval(id)
  }, [text, msPerChar, reduced])

  if (reduced) return text
  return text.slice(0, state.text === text ? state.count : 0)
}
