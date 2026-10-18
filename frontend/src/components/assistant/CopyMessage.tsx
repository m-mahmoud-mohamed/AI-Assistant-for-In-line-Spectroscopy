import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'

export function CopyMessage({ text }: { text: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  return <span className="message-copy">
    <button type="button" className="link-btn" aria-label={status === 'copied' ? 'Copied' : 'Copy message'} onClick={async () => {
      try {
        await navigator.clipboard.writeText(text)
        setStatus('copied')
      } catch { setStatus('error') }
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setStatus('idle'), 2000)
    }}>{status === 'copied' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}<span>{status === 'copied' ? 'Copied' : 'Copy'}</span></button>
    {status === 'error' && <span role="status">Could not copy. Select the text to copy it.</span>}
  </span>
}
