// Streaming reveal of a fresh report: words blur in one by one. A section starts `sectionStagger` ms after the
// previous one; inside it, paragraph and bullet `n` starts a little later, and the words of an item are spread so
// the whole section is done about `sectionCap` ms after it started. A stored report never reveals.
import type { ReactNode } from 'react'
import { RevealWords } from '../../motion'
import { REVEAL, itemOffset, useRevealDelay } from './revealState'

/** Text that reveals word by word while a fresh report streams in; plain text otherwise. */
export function Rv({ children, item = 0 }: { children: ReactNode; item?: number }) {
  const delay = useRevealDelay(item)
  if (delay === null) return <>{children}</>
  return (
    <RevealWords
      delay={delay}
      stagger={REVEAL.wordStagger}
      perWordCap={REVEAL.sectionCap - itemOffset(item)}
      duration={REVEAL.wordMs}
      blur={4}
      rise="0.2em"
    >
      {children}
    </RevealWords>
  )
}

