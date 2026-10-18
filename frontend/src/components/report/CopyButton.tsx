import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'

export function CopyButton({ label, text }: { label: string; text: string | (() => string) }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (status === 'idle') return
    const timer = setTimeout(() => setStatus('idle'), 1800)
    return () => clearTimeout(timer)
  }, [status])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(typeof text === 'function' ? text() : text)
      setStatus('copied')
    } catch {
      setStatus('failed')
    }
  }
  return (
    <button type="button" className="btn btn-sm btn-icon report-copy" aria-label={`Copy ${label}`} title={`Copy ${label}`} onClick={() => void copy()} data-print-hide data-copy-ignore>
      {status === 'copied' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      <span aria-live="polite" className={status === 'idle' ? 'sr-only' : 'copy-feedback'}>{status === 'copied' ? 'Copied' : status === 'failed' ? 'Copy unavailable' : `Copy ${label}`}</span>
    </button>
  )
}
