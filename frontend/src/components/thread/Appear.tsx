import type { ReactNode } from 'react'
import { BlurIn, type BlurInProps } from '../../motion'

/** A blur-in entrance when `animate` is set (a fresh run), else the content as is: stored sessions render instantly. */
export function Appear({ animate, children, as: Tag = 'div', className, id, style, ...motion }: { animate: boolean; children?: ReactNode } & BlurInProps) {
  if (!animate) {
    return (
      <Tag className={className} id={id} style={style}>
        {children}
      </Tag>
    )
  }
  return (
    <BlurIn as={Tag} className={className} id={id} style={style} {...motion}>
      {children}
    </BlurIn>
  )
}
