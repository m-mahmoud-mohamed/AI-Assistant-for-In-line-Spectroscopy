import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useFocusTrap } from '../shell/useFocusTrap'
import { usePresence } from '../shell/usePresence'
import './panel.css'

interface LightboxProps {
  open: boolean
  src: string
  alt: string
  onClose: () => void
}

function Box({ src, alt, onClose, leaving }: Omit<LightboxProps, 'open'> & { leaving: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(ref, !leaving)
  useEffect(() => {
    // Capture phase + stopPropagation: Esc closes the lightbox only, not the drawer or panel under it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      className="lb"
      data-leaving={leaving || undefined}
      aria-hidden={leaving || undefined}
      onClick={onClose}
      data-print-hide
    >
      <button type="button" className="lb-close" aria-label="Close enlarged page" onClick={onClose}>
        <X size={18} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <img src={src} alt={`${alt} (enlarged)`} className="lb-img" onClick={(e) => e.stopPropagation()} />
    </div>
  )
}

/** Full-viewport zoom of a source page image; click, the close button or Esc dismisses it. */
export function Lightbox({ open, ...rest }: LightboxProps) {
  const { mounted, leaving } = usePresence(open, 120)
  // A portal: the report pane contains its layout, which would otherwise pin this "full-viewport" box to the pane.
  return mounted ? createPortal(<Box {...rest} leaving={leaving} />, document.body) : null
}
