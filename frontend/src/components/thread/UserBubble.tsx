import { useLayoutEffect, useRef, useState } from 'react'
import { BlurIn } from '../../motion'

export interface UserBubbleProps {
  text: string
  /** Delay of the entrance, ms (the first bubble rises 80 ms after the composer starts gliding). */
  delay?: number
  /** Rise distance in px. */
  rise?: number
}

/** Right-aligned lavender bubble; long enquiries clamp to four lines with "Show full enquiry". */
export function UserBubble({ text, delay = 0, rise = 12 }: UserBubbleProps) {
  const ref = useRef<HTMLParagraphElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (el && !expanded) setOverflows(el.scrollHeight > el.clientHeight + 1)
  }, [text, expanded])

  return (
    <BlurIn className="bubble-row" delay={delay} duration={420} y={rise} blur={4}>
      <div className="bubble">
        <p
          ref={ref}
          style={{
            margin: 0,
            ...(expanded ? {} : { display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical' as const, overflow: 'hidden' }),
          }}
        >
          {text}
        </p>
        {(overflows || expanded) && (
          <button type="button" className="bubble-more" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)}>
            {expanded ? 'Show less' : 'Show full enquiry'}
          </button>
        )}
      </div>
    </BlurIn>
  )
}
