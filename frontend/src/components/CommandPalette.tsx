import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CornerDownLeft, Search, type LucideIcon } from 'lucide-react'
import { usePresence } from './shell/usePresence'
import { useFocusTrap } from './shell/useFocusTrap'
import './panel/panel.css'

export interface Command {
  id: string
  label: string
  /** Extra words that match the search. */
  keywords?: string
  group: string
  icon: LucideIcon
  run: () => void
}

interface CommandPaletteProps {
  open: boolean
  commands: Command[]
  onClose: () => void
}

const matches = (c: Command, query: string) => {
  const hay = `${c.group} ${c.label} ${c.keywords ?? ''}`.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word))
}

function Palette({ commands, onClose, leaving }: Omit<CommandPaletteProps, 'open'> & { leaving: boolean }) {
  const titleId = useId()
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [shortcuts, setShortcuts] = useState(false)
  const results = useMemo(() => commands.filter((c) => matches(c, query)).slice(0, 30), [commands, query])
  const current = Math.min(active, Math.max(0, results.length - 1))
  // Opened with the mouse from the top bar's Search button: grow out of that button. Opened with the keyboard
  // (a shortcut used all day): no entrance animation at all.
  const [fromTrigger] = useState(() => !!(document.activeElement as HTMLElement | null)?.closest?.('[data-palette-origin]'))

  useLayoutEffect(() => {
    const panel = panelRef.current
    const trigger = document.querySelector<HTMLElement>('[data-palette-origin]')
    if (!panel || !trigger) return
    const t = trigger.getBoundingClientRect()
    const p = panel.getBoundingClientRect()
    panel.style.transformOrigin = `${Math.round(t.left + t.width / 2 - p.left)}px ${Math.round(t.bottom - p.top)}px`
  }, [])

  useFocusTrap(panelRef, !leaving)
  useEffect(() => {
    document.getElementById(`${listId}-${current}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [listId, current])

  const run = (c: Command | undefined) => {
    if (!c) return
    onClose()
    c.run()
  }

  const optionId = (i: number) => `${listId}-${i}`

  return (
    <div
      className="ov-modal-scrim pal-scrim"
      data-leaving={leaving || undefined}
      aria-hidden={leaving || undefined}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      data-print-hide
    >
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="pal" data-animate={fromTrigger} onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }
      }}>
        <h2 id={titleId} className="sr-only">
          Command palette
        </h2>
        <div className="pal-search">
          <Search size={16} strokeWidth={1.75} aria-hidden="true" />
          <input
            ref={inputRef}
            role="combobox"
            aria-label="Command"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={results.length ? optionId(current) : undefined}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                onClose()
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((current + 1) % Math.max(1, results.length))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((current - 1 + results.length) % Math.max(1, results.length))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                run(results[current])
              }
            }}
            placeholder="New enquiry, open an assessment, export…"
          />
          <kbd className="kbd">esc</kbd>
        </div>
        <ul id={listId} role="listbox" aria-label="Commands" className="pal-list">
          {results.length === 0 && <li className="pal-empty" role="presentation">No matching command. Try an assessment title or fewer search words.</li>}
          {results.map((c, i) => {
            const Icon = c.icon
            const heading = i === 0 || results[i - 1].group !== c.group
            return (
              <Fragment key={c.id}>
                {heading && (
                  <li role="presentation" className="pal-group">
                    {c.group}
                  </li>
                )}
                <li
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === current}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => run(c)}
                  className="pal-option"
                >
                  <span className="pal-icon">
                    <Icon size={15} strokeWidth={1.75} aria-hidden="true" />
                  </span>
                  <span className="pal-label">{c.label}</span>
                  {i === current && <CornerDownLeft size={14} strokeWidth={1.75} aria-hidden="true" className="pal-enter" />}
                </li>
              </Fragment>
            )
          })}
        </ul>
        <div className="pal-foot">
          <span>
            <kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> to move
          </span>
          <span>
            <kbd className="kbd">↵</kbd> to run
          </span>
          <button type="button" className="link-btn" aria-expanded={shortcuts} aria-controls={`${listId}-shortcuts`} onClick={() => setShortcuts((value) => !value)}>Keyboard shortcuts</button>
        </div>
        {shortcuts && <dl id={`${listId}-shortcuts`} className="pal-shortcuts" aria-label="Keyboard shortcuts">
          <div><dt><kbd>Ctrl K</kbd> / <kbd>⌘K</kbd></dt><dd>Open search and commands</dd></div>
          <div><dt><kbd>↑</kbd> / <kbd>↓</kbd>, <kbd>Enter</kbd></dt><dd>Choose and run a command</dd></div>
          <div><dt><kbd>Esc</kbd></dt><dd>Close a menu or dialog</dd></div>
          <div><dt><kbd>1–8</kbd></dt><dd>Switch report tabs when not typing</dd></div>
          <div><dt><kbd>←</kbd> / <kbd>→</kbd>, <kbd>Home</kbd> / <kbd>End</kbd></dt><dd>Move between focused report tabs</dd></div>
          <div><dt><kbd>Enter</kbd> / <kbd>Shift Enter</kbd></dt><dd>Send a message / add a new line</dd></div>
        </dl>}
      </div>
    </div>
  )
}

/** `⌘K` / `Ctrl+K` palette: new enquiry, history, open an assessment, exports. */
export function CommandPalette({ open, ...rest }: CommandPaletteProps) {
  const { mounted, leaving } = usePresence(open, 110)
  return mounted ? <Palette {...rest} leaving={leaving} /> : null
}
