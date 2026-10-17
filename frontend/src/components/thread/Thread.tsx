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
/** An enquiry bubble taller than this share of the thread is too tall to rest on: the Results heading is used instead. */
const TALL_BUBBLE = 0.45

/** Scroll to `top`, smoothly where supported (jsdom has no Element.scrollTo). */
function scrollToTop(el: HTMLElement, top: number, smooth: boolean) {
  if (typeof el.scrollTo === 'function') el.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' })
  else el.scrollTop = top
}

/**
 * The conversation: enquiry bubble, the assessment block, then follow-ups inline. Content starts at the top
 * and scrolls above the docked composer (which the shell renders). While a run is in flight the newest content stays above
 * the composer. A report that arrives (fresh or reopened) is read from its start: the thread rests on the enquiry
 * bubble (or the Results heading when the bubble is very tall) and stops following, so the word reveal growing
 * below never drags it to the tail. Following resumes when the user sends something or scrolls to the bottom.
 */
export function Thread({ assessment: a }: ThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  /** Whether the thread follows growing content: off once a report rests, or the user scrolled up. */
  const auto = useRef(true)
  const programmaticUntil = useRef(0)
  const lastHeight = useRef(0)

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

  /** Where following the tail scrolls to: the bottom, but never past the start of the newest follow-up turn. */
  const tailTarget = useCallback(() => {
    const sc = scrollRef.current
    const inner = innerRef.current
    if (!sc || !inner) return 0
    let target = sc.scrollHeight
    const last = inner.lastElementChild as HTMLElement | null
    if (last && inner.children.length > 2) {
      const top = last.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 16
      target = Math.min(target, Math.max(0, top))
    }
    return target
  }, [])

  // Follow growing content (pipeline steps, follow-up answers) while following is on.
  useEffect(() => {
    const inner = innerRef.current
    const sc = scrollRef.current
    if (!inner || !sc || typeof ResizeObserver === 'undefined') return
    lastHeight.current = inner.offsetHeight
    const ro = new ResizeObserver(() => {
      const h = inner.offsetHeight
      const grew = h - lastHeight.current
      lastHeight.current = h
      if (!auto.current) return
      const anchors = inner.querySelectorAll<HTMLElement>('[data-follow-anchor]')
      const block = anchors[anchors.length - 1]
      if (grew > ARRIVAL_PX && block && block.nextElementSibling === null) {
        // a new "Report vN" block arrived: show it from its start and stop following, so the reveal grows below it
        const top = block.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 16
        scrollTo(Math.max(0, top), true)
        auto.current = false
        return
      }
      // follow the tail, but never past the start of the newest turn (a long follow-up answer stays readable)
      scrollTo(tailTarget(), false)
    })
    ro.observe(inner)
    return () => ro.disconnect()
  }, [scrollTo, tailTarget])

  // A new run (or a newly opened session) starts out following. Declared before the arrival effect: both are
  // layout effects, so they run in this order in the same commit.
  useLayoutEffect(() => {
    auto.current = true
  }, [a.activeRunId])

  // A report that arrives (fresh or reopened) is read from its start: rest on the enquiry bubble (or the Results
  // heading when the bubble is very tall) and stop following until the user sends something or reaches the bottom.
  const hasReport = !!a.report
  useLayoutEffect(() => {
    if (!hasReport) return
    const sc = scrollRef.current
    const inner = innerRef.current
    if (!sc || !inner) return
    let top = 0
    const bubble = inner.firstElementChild as HTMLElement | null
    const results = inner.querySelector<HTMLElement>('[id^="results-title-"]')
    if (bubble && results && bubble.offsetHeight > sc.clientHeight * TALL_BUBBLE) {
      top = Math.max(0, results.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 16)
    }
    scrollTo(top, true)
    auto.current = false
  }, [hasReport, a.activeRunId, scrollTo])

  // Something new from the user (a follow-up, a re-run): follow it again, bringing it into view.
  const turnCount = a.turns.length
  const lastKind = a.turns[turnCount - 1]?.kind
  useEffect(() => {
    if (turnCount > 0 && lastKind !== 'history') {
      auto.current = true
      scrollTo(tailTarget(), true)
    }
  }, [turnCount, lastKind, scrollTo, tailTarget])

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
