import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { TabId } from '../../state/tabs'

export interface TabSpec {
  id: TabId
  label: string
  /** A count after the label (Methods 6). */
  count?: ReactNode
  /** Tints the count: a failing checks tally reads red. */
  tone?: 'bad'
}

interface TabBarProps {
  tabs: TabSpec[]
  active: TabId
  onSelect: (id: TabId) => void
  label?: string
}

/**
 * Underline tabs (WAI-ARIA tablist): roving tabindex, ←/→ and Home/End move and select, the violet underline slides
 * between tabs on `transform` (200 ms ease-out) and is already in place on first paint. On a narrow pane the strip scrolls.
 */
export function TabBar({ tabs, active, onSelect, label = 'Report sections' }: TabBarProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const refs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({})
  const [ready, setReady] = useState(false)

  const place = useCallback(() => {
    const el = refs.current[active]
    const box = list.current
    if (!el || !box) return
    box.style.setProperty('--x', `${el.offsetLeft}px`)
    box.style.setProperty('--w', String(el.offsetWidth / 100))
    // keep the active tab inside the strip when it scrolls
    const sc = scroller.current
    if (sc) {
      if (el.offsetLeft < sc.scrollLeft) sc.scrollLeft = Math.max(0, el.offsetLeft - 16)
      else if (el.offsetLeft + el.offsetWidth > sc.scrollLeft + sc.clientWidth) sc.scrollLeft = el.offsetLeft + el.offsetWidth - sc.clientWidth + 16
    }
  }, [active])

  useLayoutEffect(place, [place, tabs])
  useEffect(() => {
    // the underline snaps to its first position, then glides
    const raf = requestAnimationFrame(() => setReady(true))
    const box = list.current
    const ro = typeof ResizeObserver !== 'undefined' && box ? new ResizeObserver(place) : null
    if (box) ro?.observe(box)
    void document.fonts?.ready?.then(place)
    window.addEventListener('resize', place)
    return () => {
      cancelAnimationFrame(raf)
      ro?.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [place])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === active)
    const to =
      e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1
    if (to < 0) return
    e.preventDefault()
    const next = tabs[to].id
    onSelect(next)
    refs.current[next]?.focus()
  }

  return (
    <div ref={scroller} className="rt-scroll">
      <div ref={list} role="tablist" aria-label={label} className="rt-list" data-ready={ready} onKeyDown={onKeyDown}>
        {tabs.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el
            }}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={t.id === active}
            aria-controls={`tabpanel-${t.id}`}
            tabIndex={t.id === active ? 0 : -1}
            className="rt"
            onClick={() => onSelect(t.id)}
          >
            {t.label}
            {t.count !== undefined && (
              <span className="rt-count tabular" data-tone={t.tone}>
                {t.count}
              </span>
            )}
          </button>
        ))}
        <span className="rt-ind" aria-hidden="true" />
      </div>
    </div>
  )
}
