import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, Globe, Loader2, Paperclip, Square } from 'lucide-react'
import { useFlip, useReducedMotion } from '../../motion'

export interface ComposerHandle {
  focus: () => void
  /** Open the file picker (the side panel's "Attach file"). */
  attach: () => void
}

export interface ComposerProps {
  value: string
  onChange: (text: string) => void
  /** Called with the trimmed text when the user sends (Enter, or the send button). */
  onSubmit: (text: string) => void
  placeholder: string
  deep: boolean
  onDeepChange: (deep: boolean) => void
  web: boolean
  onWebChange: (web: boolean) => void
  /** API unreachable: sending is disabled. */
  offline?: boolean
  /** A request is in flight: sending is disabled. */
  busy?: boolean
  /** An assistant turn is running: the send button becomes Stop (and Enter sends nothing). */
  running?: boolean
  onStop?: () => void
  /** false: centred under the greeting (home). true: docked at the bottom of the conversation column. */
  docked: boolean
  /** Content stacked above the input inside the dock (the suggested-task chips). */
  above?: ReactNode
  /** Not shown (the narrow workspace is on its report pane); the component stays mounted. */
  hidden?: boolean
  /** Receives a handle to focus the input / open the file picker (null on unmount). */
  registerHandle?: (handle: ComposerHandle | null) => void
}

const MAX_FILE_BYTES = 512 * 1024
const MAX_LINES_PX = 144 // 6 lines of 24px

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.readAsText(file)
  })
}

function Switch({
  checked,
  onChange,
  label,
  title,
  icon,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  title: string
  icon?: ReactNode
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} title={title} className="switch" onClick={() => onChange(!checked)}>
      <span className="switch-track" aria-hidden="true" />
      {icon}
      <span>{label}</span>
    </button>
  )
}

/**
 * The enquiry / follow-up input: attach (reads a text file into the input), Deep and Web switches, send.
 * One instance lives in the app shell; `docked` moves it between the home centre and the thread's bottom
 * with a FLIP glide.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  placeholder,
  deep,
  onDeepChange,
  web,
  onWebChange,
  offline = false,
  busy = false,
  running = false,
  onStop,
  docked,
  above,
  hidden = false,
  registerHandle,
}: ComposerProps) {
  const reduced = useReducedMotion()
  const wrapRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [attachError, setAttachError] = useState<string | null>(null)
  const textId = useId()
  // The home composer rises in once after the greeting (intro choreography).
  const [intro, setIntro] = useState(!docked)
  useEffect(() => {
    const t = setTimeout(() => setIntro(false), 2200)
    return () => clearTimeout(t)
  }, [])

  useFlip(wrapRef, docked, { duration: 520, reduced })

  // The conversation scrolls above the dock: tell the stage how tall it is (chips included) so content clears it.
  useLayoutEffect(() => {
    const wrap = wrapRef.current
    const stage = wrap?.parentElement
    if (!wrap || !stage) return
    const set = () => stage.style.setProperty('--dock-h', `${wrap.offsetHeight}px`)
    set()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(set) : null
    ro?.observe(wrap)
    return () => {
      ro?.disconnect()
      stage.style.removeProperty('--dock-h')
    }
  }, [])

  useEffect(() => {
    registerHandle?.({
      focus: () => {
        const el = textRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      },
      attach: () => fileRef.current?.click(),
    })
    return () => registerHandle?.(null)
  }, [registerHandle])

  // Grow with the text up to six lines.
  const resize = useCallback(() => {
    const el = textRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_LINES_PX)}px`
  }, [])
  useLayoutEffect(resize, [value, resize])

  const canSend = value.trim().length > 0 && !offline && !busy && !running

  const send = () => {
    if (canSend) onSubmit(value.trim())
  }

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setAttachError(null)
    if (file.size > MAX_FILE_BYTES) {
      setAttachError('That file is too large to paste (limit 512 KB).')
      return
    }
    try {
      const text = (await readText(file)).trim()
      if (!text) {
        setAttachError('The file has no text to add.')
        return
      }
      onChange(value.trim() ? `${value.trimEnd()}\n\n${text}` : text)
      textRef.current?.focus()
    } catch {
      setAttachError('Could not read that file. Use a plain text file (.txt, .md, .eml).')
    }
  }

  return (
    <div ref={wrapRef} className="composer-wrap" data-docked={docked} data-intro={intro && !docked} hidden={hidden} data-print-hide>
      {above}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        <button
          type="button"
          className="icon-square c-attach"
          aria-label="Attach a text file"
          title="Attach a text file (.txt, .md, .eml)"
          onClick={() => fileRef.current?.click()}
        >
          <Paperclip size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".txt,.md,.eml,.text,text/plain,text/markdown,message/rfc822"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          data-testid="composer-file"
          onChange={(e) => {
            void onFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        <div className="c-text">
          <label htmlFor={textId} className="sr-only">
            {placeholder}
          </label>
          <textarea
            id={textId}
            ref={textRef}
            rows={1}
            value={value}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              }
            }}
          />
        </div>
        <div className="c-switches" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <Switch
            checked={web}
            onChange={onWebChange}
            label="Web"
            title="Search the web for verified external sources"
            icon={<Globe size={14} strokeWidth={1.75} aria-hidden="true" />}
          />
          <Switch checked={deep} onChange={onDeepChange} label="Deep" title="Deep reasoning: slower, used for the official answers" />
        </div>
        {running && onStop ? (
          <button type="button" className="send-btn c-send" data-stop="true" aria-label="Stop" title="Stop the assistant" onClick={onStop}>
            <Square size={13} strokeWidth={0} fill="currentColor" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="submit"
            className="send-btn c-send"
            aria-label="Send"
            disabled={!canSend}
            title={offline ? "PRISM's API is not reachable" : undefined}
          >
            {busy ? <Loader2 size={16} className="spin" aria-hidden="true" /> : <ArrowUp size={18} strokeWidth={2} aria-hidden="true" />}
          </button>
        )}
      </form>
      {attachError && (
        <p role="alert" style={{ margin: '8px 4px 0', fontSize: 13, color: 'var(--status-bad)' }}>
          {attachError}
        </p>
      )}
    </div>
  )
}
