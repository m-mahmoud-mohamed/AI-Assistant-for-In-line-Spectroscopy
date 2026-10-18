import { useCallback, useEffect, useLayoutEffect, useRef, type WheelEvent } from 'react'
import { ProgressBlock } from '../assistant/ProgressBlock'
import { runSteps, runDuration } from '../assistant/progressSteps'
import type { Assessment } from '../../state/useAssessment'
import { FollowUps } from '../thread/FollowUps'
import { UserBubble } from '../thread/UserBubble'

const NEAR_BOTTOM_PX = 120
/** Scroll events within this long of our own smooth scroll are not the user's. */
const PROGRAMMATIC_MS = 700

/** Scroll to `top`, smoothly where supported (jsdom has no Element.scrollTo). */
function scrollToTop(el: HTMLElement, top: number, smooth: boolean) {
  if (typeof el.scrollTo === 'function') el.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' })
  else el.scrollTop = top
}

/**
 * The left column: the enquiry bubble, the run's progress (live steps, then one summary line), the follow-up turns
 * and the "Report vN ready" notices. The composer docks at its bottom (the shell renders it). The column follows
 * growing content (pipeline steps, a streaming answer) until the user scrolls up; sending something follows again.
 */
export function Conversation({ assessment: a }: { assessment: Assessment }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const auto = useRef(true)
  const programmaticUntil = useRef(0)

  const toBottom = useCallback((smooth: boolean) => {
    const el = scrollRef.current
    if (!el) return
    programmaticUntil.current = performance.now() + PROGRAMMATIC_MS
    // A card the assistant waits on that is taller than the column: show its top (its question) rather than its foot.
    const waiting = innerRef.current?.querySelector<HTMLElement>('[data-awaiting="true"]')
    const bottom = el.scrollHeight - el.clientHeight
    const cardTop = waiting ? waiting.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 16 : bottom
    scrollToTop(el, Math.max(0, Math.min(bottom, cardTop)), smooth && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  }, [])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el || performance.now() < programmaticUntil.current) return
    auto.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
  }
  const onWheel = (e: WheelEvent) => {
    if (e.deltaY < 0) {
      auto.current = false
      programmaticUntil.current = 0
    }
  }

  useEffect(() => {
    const inner = innerRef.current
    if (!inner || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (auto.current) toBottom(false)
    })
    ro.observe(inner)
    return () => ro.disconnect()
  }, [toBottom])

  // A newly opened session or a new run starts out following.
  useLayoutEffect(() => {
    auto.current = true
  }, [a.selectedId, a.activeRunId])

  // Something new from the user (a follow-up, a re-run): follow it, bringing it into view.
  const turnCount = a.turns.length
  const lastKind = a.turns[turnCount - 1]?.kind
  useEffect(() => {
    if (turnCount > 0 && lastKind !== 'history') {
      auto.current = true
      toBottom(true)
    }
  }, [turnCount, lastKind, toBottom])

  const { report, refusal, failure, loading, run, activeRunId } = a
  return (
    <section className="ws-conv" aria-label="Conversation" data-testid="conversation">
      <div ref={scrollRef} className="ws-conv-scroll" onScroll={onScroll} onWheel={onWheel}>
        <div ref={innerRef} className="ws-conv-inner">
          {a.enquiryText && <UserBubble text={a.enquiryText} delay={80} rise={28} />}
          <div className="assistant-block" aria-label="Assessment progress" role="region">
            {!a.turnOwnsRun && (loading || activeRunId || report) && <ProgressBlock steps={runSteps(run.state)} status={run.state.status} seconds={runDuration(run.state)} />}
            {failure && !refusal && <p className="rs-muted">The run failed; the report pane has the details.</p>}
          </div>
          {a.selectedId && <FollowUps assessment={a} />}
          {a.sessionLoading && !a.enquiryText && <p className="rs-muted">Loading session…</p>}
          {a.sessionError && (
            <p role="alert" className="inline-error">
              Could not load the session: {a.sessionError} <button className="link-btn" onClick={a.retryConnection}>Retry</button>
            </p>
          )}
        </div>
      </div>
      <div className="dock-fade" aria-hidden="true" data-print-hide />
    </section>
  )
}
