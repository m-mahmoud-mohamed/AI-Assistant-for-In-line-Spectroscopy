import type { CSSProperties } from 'react'

export interface SkeletonProps {
  width?: number | string
  height?: number | string
  radius?: number | string
  className?: string
  style?: CSSProperties
}

/** Shimmering placeholder block. Swap it for content wrapped in `<BlurIn y={0} blur={4}>` to cross-fade. */
export function Skeleton({ width = '100%', height = 16, radius, className, style }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={`skeleton${className ? ` ${className}` : ''}`}
      style={{ width, height, ...(radius !== undefined ? { borderRadius: radius } : {}), ...style }}
    />
  )
}

/** A few stacked skeleton lines (the last one shorter). */
export function SkeletonLines({ lines = 3, height = 14, gap = 10 }: { lines?: number; height?: number; gap?: number }) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap }} role="status" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} height={height} width={i === lines - 1 ? '62%' : '100%'} />
      ))}
    </span>
  )
}
