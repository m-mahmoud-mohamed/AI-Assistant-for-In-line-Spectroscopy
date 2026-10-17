import type { CSSProperties } from 'react'

export interface OrbProps {
  /** Diameter in px. */
  size?: number
  /** Subtle scale breathing (home only). */
  breathe?: boolean
  /** Entrance: opacity 0, scale .92, blur 10px to crisp (600 ms). */
  enter?: boolean
  className?: string
}

/** CSS-only glossy purple orb: radial gradient, specular highlight, inner shade, lilac glow. */
export function Orb({ size = 72, breathe = false, enter = false, className }: OrbProps) {
  return (
    <div
      className={`orb-wrap${className ? ` ${className}` : ''}`}
      data-breathe={breathe}
      data-enter={enter}
      style={{ '--orb-size': `${size}px` } as CSSProperties}
      aria-hidden="true"
    >
      <div className="orb-halo" />
      <div className="orb" />
    </div>
  )
}
