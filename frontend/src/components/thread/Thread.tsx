import { useEffect, useLayoutEffect, useRef } from 'react'
import type { Assessment } from '../../state/useAssessment'
import { AssessmentBlock } from './AssessmentBlock'
import { FollowUps } from './FollowUps'
import { UserBubble } from './UserBubble'

export interface ThreadProps {
  /** The app state from `useAssessment()`. Phase 2 agents add fields there rather than new props here. */
  assessment: Assessment
}

const NEAR_BOTTOM_PX = 120

/** Scroll to `top`, smoothly where supported (jsdom has no Element.scrollTo). */
function scrollToTop(el: HTMLElement, top: number, smooth: boolean) {
  if (typeof el.scrollTo === 'function') el.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' })
  else el.scrollTop = top
}

/**
 * The conversation: enquiry bubble, the assessment block, then follow-ups inline. Content is bottom-anchored
 * above the docked composer (which the shell renders); the newest content stays in view unless the user
 * scrolled up.
 */
export function Thread({ assessment: a }: ThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const reportJustArrived = useRef(false)

  const onScroll = () => {
    const el = scrollRef.current
    if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
  }

  const toBottom = (smooth: boolean) => {
    const el = scrollRef.current
    if (el) scrollToTop(el, el.scrollHeight, smooth)
  }

  // Follow growing content (pipeline steps, follow-up answers) while the user has not scrolled away.
  useEffect(() => {
    const inner = innerRef.current
    if (!inner || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (following.current && !reportJustArrived.current) toBottom(false)
    })
    ro.observe(inner)
    return () => ro.disconnect()
  }, [])

  // A finished report is read from its start: scroll the thread to its top (the enquiry bubble) once.
  const hasReport = !!a.report
  useLayoutEffect(() => {
    if (!hasReport || !following.current) return
    reportJustArrived.current = true
    const el = scrollRef.current
    if (el) scrollToTop(el, 0, true)
    const t = setTimeout(() => (reportJustArrived.current = false), 800)
    return () => clearTimeout(t)
  }, [hasReport, a.activeRunId])

  // New follow-up turns: keep the newest in view.
  const turnCount = a.turns.length
  useEffect(() => {
    if (turnCount > 0) {
      following.current = true
      toBottom(true)
    }
  }, [turnCount])

  return (
    <div ref={scrollRef} className="thread-scroll" onScroll={onScroll} data-testid="thread">
      <div ref={innerRef} className="thread-inner">
        {a.enquiryText && <UserBubble text={a.enquiryText} delay={80} rise={28} />}
        <AssessmentBlock assessment={a} />
        {a.selectedId && (
          <FollowUps
            turns={a.turns}
            sessionId={a.selectedId}
            report={a.report}
            citations={a.citations}
            onCite={a.cite}
            onFill={a.fillComposer}
            onRunCompleted={a.onRunCompleted}
          />
        )}
        {a.sessionLoading && !a.enquiryText && <p style={{ margin: 0, color: 'var(--muted)' }}>Loading session…</p>}
        {a.sessionError && (
          <p role="alert" className="inline-error">
            Could not load the session: {a.sessionError}
          </p>
        )}
      </div>
    </div>
  )
}
