import './thread.css'
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { Assessment } from '../../state/useAssessment'
import { AssessmentBlock } from './AssessmentBlock'
import { FollowContext } from './follow'
import { FollowUps } from './FollowUps'
import { UserBubble } from './UserBubble'

export interface ThreadProps {
  /** The app state from `useAssessment()`. Phase 2 agents add fields there rather than new props here. */
  assessment: Assessment
}

const NEAR_BOTTOM_PX = 120
/** Room kept free at the bottom for the docked composer and its fade. */
const DOCK_PX = 140
/** A single growth bigger than this is a report arriving, not another pipeline step. */
const ARRIVAL_PX = 400
/** Scroll events within this long of our own smooth scroll are not the user's. */
const PROGRAMMATIC_MS = 700

/** Scroll to `top`, smoothly where supported (jsdom has no Element.scrollTo). */
function scrollToTop(el: HTMLElement, top: number, smooth: boolean) {
  if (typeof el.scrollTo === 'function') el.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' })
  else el.scrollTop = top
}

/**
 * The conversation: enquiry bubble, the assessment block, then follow-ups inline. Content is bottom-anchored
 * above the docked composer (which the shell renders). The newest content stays above the composer unless the
 * user scrolled up; while a fresh report reveals, each section is brought into view as it starts.
 */
export function Thread({ assessment: a }: ThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  /** False once the user scrolled up; true again when they are back near the bottom or send something. */
  const auto = useRef(true)
  const programmaticUntil = useRef(0)
  const lastHeight = useRef(0)
  const reportJustArrived = useRef(false)

  const scrollTo = useCallback((top: number, smooth: boolean) => {
    const el = scrollRef.current
    if (!el) return
    programmaticUntil.current = performance.now() + PROGRAMMATIC_MS
    scrollToTop(el, top, smooth)
  }, [])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el || performance.now() < programmaticUntil.current) return
    auto.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
  }

  const onWheel = (e: React.WheelEvent) => {
    if (e.deltaY < 0) {
      auto.current = false
      programmaticUntil.current = 0
    }
  }

  /** Bring a section that starts revealing above the composer, keeping its top in view. */
  const follow = useCallback(
    (el: HTMLElement) => {
      const sc = scrollRef.current
      if (!auto.current || !sc) return
      const box = sc.getBoundingClientRect()
      const r = el.getBoundingClientRect()
      const overflow = r.bottom - (box.bottom - DOCK_PX)
      if (overflow <= 0) return
      const room = r.top - box.top - 16
      const delta = Math.min(overflow + 16, room)
      if (delta > 0) scrollTo(sc.scrollTop + delta, true)
    },
    [scrollTo],
  )

  // Follow growing content (pipeline steps, follow-up answers) while the user has not scrolled away.
  useEffect(() => {
    const inner = innerRef.current
    const sc = scrollRef.current
    if (!inner || !sc || typeof ResizeObserver === 'undefined') return
    lastHeight.current = inner.offsetHeight
    const ro = new ResizeObserver(() => {
      const h = inner.offsetHeight
      const grew = h - lastHeight.current
      lastHeight.current = h
      if (!auto.current || reportJustArrived.current) return
      const anchors = inner.querySelectorAll<HTMLElement>('[data-follow-anchor]')
      const block = anchors[anchors.length - 1]
      if (grew > ARRIVAL_PX && block && block.nextElementSibling === null) {
        // a new "Report vN" block arrived: show it from its start, the reveal scrolls on from there
        const top = block.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 16
        scrollTo(Math.max(0, top), true)
      } else scrollTo(sc.scrollHeight, false)
    })
    ro.observe(inner)
    return () => ro.disconnect()
  }, [scrollTo])

  // A finished report is read from its start: scroll the thread to its top (the enquiry bubble) once.
  const hasReport = !!a.report
  useLayoutEffect(() => {
    if (!hasReport || !auto.current) return
    reportJustArrived.current = true
    scrollTo(0, true)
    const t = setTimeout(() => (reportJustArrived.current = false), 800)
    return () => clearTimeout(t)
  }, [hasReport, a.activeRunId, scrollTo])

  // A new report restarts following (the reveal scrolls its sections into view).
  useEffect(() => {
    auto.current = true
  }, [a.activeRunId])

  // New follow-up turns: keep the newest in view.
  const turnCount = a.turns.length
  useEffect(() => {
    if (turnCount > 0) {
      auto.current = true
      const el = scrollRef.current
      if (el) scrollTo(el.scrollHeight, true)
    }
  }, [turnCount, scrollTo])

  return (
    <FollowContext.Provider value={follow}>
      <div ref={scrollRef} className="thread-scroll" onScroll={onScroll} onWheel={onWheel} data-testid="thread">
        <div ref={innerRef} className="thread-inner">
          {a.enquiryText && <UserBubble text={a.enquiryText} delay={80} rise={28} />}
          <AssessmentBlock assessment={a} />
          {a.selectedId && <FollowUps assessment={a} />}
          {a.sessionLoading && !a.enquiryText && <p className="rs-muted">Loading session…</p>}
          {a.sessionError && (
            <p role="alert" className="inline-error">
              Could not load the session: {a.sessionError}
            </p>
          )}
        </div>
      </div>
    </FollowContext.Provider>
  )
}
