import { useEffect, useState, type ReactNode } from 'react'
import { BlurIn } from '../../motion'
import './panel.css'

interface CrossFadeProps {
  /** Content is ready: the skeleton fades out as the content blurs in (4 px to 0). */
  ready: boolean
  skeleton: ReactNode
  children: ReactNode
  /** Card index: each card starts 80 ms after the previous one. */
  index?: number
}

const STAGGER_MS = 80
const FADE_MS = 300

/**
 * Skeleton to content cross-fade: when `ready` flips, the content enters with blur(4px) to 0 and the skeleton,
 * still laid over it, fades out, so the card never blinks empty. Content that is ready on first render just shows.
 */
export function CrossFade({ ready, skeleton, children, index = 0 }: CrossFadeProps) {
  const [wasReady] = useState(ready)
  const [skeletonGone, setSkeletonGone] = useState(ready)
  useEffect(() => {
    if (!ready || skeletonGone) return
    const t = setTimeout(() => setSkeletonGone(true), index * STAGGER_MS + FADE_MS + 60)
    return () => clearTimeout(t)
  }, [ready, skeletonGone, index])

  if (wasReady) return <>{children}</>
  return (
    <div className="cf">
      {ready && (
        <BlurIn y={0} blur={4} duration={FADE_MS + 100} delay={index * STAGGER_MS}>
          {children}
        </BlurIn>
      )}
      {!skeletonGone && (
        <div className="cf-skel" data-out={ready || undefined} style={{ animationDelay: `${index * STAGGER_MS}ms` }}>
          {skeleton}
        </div>
      )}
    </div>
  )
}
