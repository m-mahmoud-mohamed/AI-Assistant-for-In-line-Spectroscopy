import type { CSSProperties, ElementType, ReactNode } from 'react'

export interface BlurInProps {
  children?: ReactNode
  /** Delay before the entrance starts, ms. */
  delay?: number
  duration?: number
  /** Rise from this many px below the resting position. */
  y?: number
  blur?: number
  /** Start scale (1 = none). */
  scale?: number
  as?: ElementType
  className?: string
  style?: CSSProperties
  id?: string
  /** Play the leaving animation instead (blur out, scale .98), e.g. the greeting on submit. */
  out?: boolean
}

/**
 * Blur / opacity / translate entrance (CSS keyframes `blur-in`) that runs when the element mounts.
 * The element is fully visible without the animation, so a missing animation never hides content.
 * Reduced motion: opacity fade only (theme.css).
 */
export function BlurIn({
  children,
  delay = 0,
  duration = 450,
  y = 8,
  blur = 6,
  scale = 1,
  as: Tag = 'div',
  className,
  style,
  id,
  out = false,
}: BlurInProps) {
  const vars = {
    '--bi-delay': `${delay}ms`,
    '--bi-dur': `${duration}ms`,
    '--bi-y': `${y}px`,
    '--bi-blur': `${blur}px`,
    '--bi-scale': String(scale),
    ...style,
  } as CSSProperties
  return (
    <Tag id={id} className={`${out ? 'blur-out' : 'blur-in'}${className ? ` ${className}` : ''}`} style={vars}>
      {children}
    </Tag>
  )
}
