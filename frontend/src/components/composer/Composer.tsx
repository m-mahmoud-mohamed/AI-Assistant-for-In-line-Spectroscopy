import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, Globe, Loader2, Mic, Paperclip, SlidersHorizontal, Square } from 'lucide-react'
import { useSpeech, type SpeechLanguage } from '../../features/speech/useSpeech'
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
const MAX_LINES_PX = 240

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
  const errorId = useId()
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [language, setLanguage] = useState<SpeechLanguage>('auto')
  const composing = useRef(false)
  const sentValue = useRef<string | null>(null)
  useEffect(() => { sentValue.current = null }, [value, busy, running])
  // The caret at the moment recording starts; a field never focused takes the transcript at its end.
  const caret = useRef<{ start: number; end: number } | null>(null)
  const focused = useRef(false)
  const speech = useSpeech((text) => {
    const el = textRef.current
    const start = Math.min(caret.current?.start ?? value.length, value.length)
    const end = Math.min(caret.current?.end ?? start, value.length)
    const before = value.slice(0, start)
    const after = value.slice(end)
    const inserted = `${before && !/\s$/.test(before) ? ' ' : ''}${text}${after && !/^\s/.test(after) ? ' ' : ''}`
    onChange(before + inserted + after)
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(start + inserted.length, start + inserted.length) })
  })
  const voiceBusy = speech.phase !== 'idle' 
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
    const panelHeight = wrapRef.current?.closest('.app-stage')?.clientHeight ?? 600
    el.style.height = `${Math.min(el.scrollHeight, MAX_LINES_PX, Math.max(48, panelHeight * 0.4))}px`
  }, [])
  useLayoutEffect(resize, [value, resize])

  const canSend = value.trim().length > 0 && !offline && !busy && !running && !voiceBusy

  const send = () => {
    if (canSend && sentValue.current !== value) { sentValue.current = value; onSubmit(value.trim()) }
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
        aria-busy={busy || speech.phase === 'transcribing'}
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
            dir="auto"
            enterKeyHint="send"
            aria-describedby={attachError || speech.error ? errorId : undefined}
            onFocus={() => { focused.current = true }}
            onCompositionStart={() => { composing.current = true }}
            onCompositionEnd={() => { composing.current = false }}
            value={value}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !composing.current && e.keyCode !== 229) {
                e.preventDefault()
                send()
              }
            }}
          />
        </div>
        <div className="c-options">
          <button type="button" className="icon-square" aria-label="Composer options" aria-expanded={optionsOpen} aria-controls={`${textId}-options`} onClick={() => setOptionsOpen(!optionsOpen)}><SlidersHorizontal size={16} aria-hidden="true" /></button>
          {optionsOpen && <div id={`${textId}-options`} className="c-options-panel" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setOptionsOpen(false) } }}>
            <Switch checked={web} onChange={onWebChange} label="Web" title="Search verified external sources" icon={<Globe size={14} aria-hidden="true" />} />
            <Switch checked={deep} onChange={onDeepChange} label="Deep" title="Use deep reasoning" />
            <label>Voice language <select value={language} onChange={(e) => setLanguage(e.target.value as SpeechLanguage)} disabled={voiceBusy} aria-label="Voice language"><option value="auto">Auto</option><option value="en">English</option><option value="ar">العربية</option></select></label>
          </div>}
        </div>
        <button type="button" className="icon-square c-mic" aria-label={speech.phase === 'recording' ? 'Stop recording' : speech.phase === 'transcribing' ? 'Transcribing' : 'Record voice'} aria-pressed={speech.phase === 'recording'} disabled={offline || busy || running || speech.phase === 'requesting' || speech.phase === 'transcribing'} onClick={() => { if (speech.phase === 'recording') speech.stop(); else { const el = textRef.current; caret.current = focused.current && el ? { start: el.selectionStart, end: el.selectionEnd } : null; void speech.start(language) } }}>
          {speech.phase === 'transcribing' || speech.phase === 'requesting' ? <Loader2 size={16} className="spin" aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />}
        </button>
        {speech.phase === 'recording' ? <button type="button" className="send-btn c-send" aria-label="Stop recording" onClick={speech.stop}><Square size={13} fill="currentColor" aria-hidden="true" /></button> : running && onStop ? (
          <button type="button" className="send-btn c-send" data-stop="true" aria-label="Stop" title="Stop the assistant" onClick={onStop}>
            <Square size={13} strokeWidth={0} fill="currentColor" aria-hidden="true" />
          </button>
        ) : (
          <button type="submit" className="send-btn c-send" aria-label="Send" disabled={!canSend} title={offline ? "PRISM's API is not reachable" : undefined}>
            {busy ? <Loader2 size={16} className="spin" aria-hidden="true" /> : <ArrowUp size={18} strokeWidth={2} aria-hidden="true" />}
          </button>
        )}
      </form>
      {voiceBusy && <p className="c-voice-status" role="status">{speech.phase === 'recording' ? `Recording · ${Math.floor(speech.elapsed / 60)}:${String(speech.elapsed % 60).padStart(2, '0')} / 2:00` : speech.phase === 'requesting' ? 'Waiting for microphone permission…' : 'Transcribing…'} <button type="button" className="link-btn" onClick={speech.cancel}>Cancel</button></p>}
      {(attachError || speech.error) && (
        <p id={errorId} role="alert" style={{ margin: '8px 4px 0', fontSize: 13, color: 'var(--status-bad)' }}>
          {attachError || speech.error}
        </p>
      )}
    </div>
  )
}
