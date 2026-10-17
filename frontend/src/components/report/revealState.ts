// Reveal timing and contexts (see reveal.tsx for the `Rv` component).
import { createContext, useContext } from 'react'
import { useReducedMotion } from '../../motion'

export const REVEAL = { sectionStagger: 120, wordStagger: 25, sectionCap: 900, itemStep: 90, itemMax: 360, wordMs: 380 } as const

export interface RevealState {
  /** A fresh report is being revealed. */
  enabled: boolean
  /** Called when a section starts revealing, so the thread can keep it above the composer. */
  follow?: (el: HTMLElement) => void
  /** Delay (ms) before the first section starts (the Sources row reveals first). */
  base?: number
}

export const RevealContext = createContext<RevealState>({ enabled: false })
/** Start delay (ms) of the section being rendered, relative to the reveal's base delay. */
export const SectionStartContext = createContext(0)
/** True while printing: every disclosure is open. */
export const ExpandAllContext = createContext(false)

export const itemOffset = (item: number) => Math.min(item * REVEAL.itemStep, REVEAL.itemMax)

/** Start delay (ms) of item `item` in the current section, or null when no reveal is playing. */
export function useRevealDelay(item = 0): number | null {
  const { enabled, base = 0 } = useContext(RevealContext)
  const reduced = useReducedMotion()
  const start = useContext(SectionStartContext)
  return enabled && !reduced ? base + start + itemOffset(item) : null
}

/** Time (ms) a report with `sections` sections needs to finish revealing. */
export const revealDuration = (sections: number): number =>
  Math.max(0, sections - 1) * REVEAL.sectionStagger + REVEAL.sectionCap + REVEAL.wordMs
