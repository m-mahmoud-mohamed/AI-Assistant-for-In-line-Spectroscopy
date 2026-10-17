import { useLayoutEffect, useMemo, useRef } from 'react'
import { CircleAlert, Unplug } from 'lucide-react'
import { BlurIn, Orb, RevealWords, greetingLines } from '../../motion'

export interface HomeProps {
  /** The API is unreachable: shows the inline notice (the composer's send is disabled by the shell). */
  offline: boolean
  /** The last start attempt failed. */
  startError: string | null
  /** The submit transition is running: orb and greeting blur out. */
  leaving?: boolean
}

/**
 * Home: orb, greeting and a slot where the shell's composer sits. Intro choreography (matches the video):
 * orb 600 ms blur-in, greeting words 55 ms apart (emphasis words last), composer rises 250 ms after the greeting.
 */
export function Home({ offline, startError, leaving = false }: HomeProps) {
  const slotRef = useRef<HTMLDivElement>(null)
  const lines = useMemo(() => greetingLines(), [])

  // Tell the stage where the composer goes: right under the greeting (CSS variable, no React state).
  useLayoutEffect(() => {
    const slot = slotRef.current
    const body = slot?.closest<HTMLElement>('.app-body')
    if (!slot || !body) return
    const place = () => {
      const top = slot.getBoundingClientRect().top - body.getBoundingClientRect().top
      body.style.setProperty('--home-composer-top', `${Math.round(top)}px`)
    }
    place()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null
    ro?.observe(body)
    ro?.observe(slot.parentElement as Element)
    window.addEventListener('resize', place)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [])

  const leaveClass = leaving ? 'blur-out' : ''
  return (
    <section className="home" aria-label="New enquiry" style={leaving ? { pointerEvents: 'none' } : undefined}>
      <div className={leaveClass} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Orb size={72} breathe enter />
        <h1 className="greeting" style={{ marginTop: 28 }} aria-label={`${lines.first} ${lines.second} ${lines.emphasis}`}>
          <RevealWords as="span" delay={700} stagger={55} mask className="greeting-line">
            {lines.first}
          </RevealWords>
          {' '}
          <br />
          <RevealWords as="span" delay={700 + 55 * 2} stagger={55} mask className="greeting-line">
            {lines.second} <span data-word-class="emph-word">{lines.emphasis}</span>
          </RevealWords>
        </h1>
      </div>
      <div ref={slotRef} aria-hidden="true" className="home-slot" />
      <div style={{ minHeight: 56, marginTop: 14 }} aria-live="polite">
        {!leaving && offline && (
          <BlurIn delay={1500} y={6} blur={4} className="notice" as="p" style={{ margin: 0 }}>
            <Unplug size={16} strokeWidth={1.75} aria-hidden="true" />
            <span>
              PRISM's API is not reachable — start it with <code>make api</code>.
            </span>
          </BlurIn>
        )}
        {!leaving && !offline && startError && (
          <p role="alert" className="notice" style={{ margin: 0, color: 'var(--status-bad)', background: 'var(--status-bad-bg)' }}>
            <CircleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
            <span>{startError}</span>
          </p>
        )}
      </div>
    </section>
  )
}
