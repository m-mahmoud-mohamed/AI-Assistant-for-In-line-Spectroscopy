import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Command as CommandIcon, type LucideIcon } from 'lucide-react'

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

function Palette({ commands, onClose }: Omit<CommandPaletteProps, 'open'>) {
  const titleId = useId()
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const results = useMemo(() => commands.filter((c) => matches(c, query)).slice(0, 30), [commands, query])
  const current = Math.min(active, Math.max(0, results.length - 1))

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    inputRef.current?.focus()
    return () => previous?.focus?.()
  }, [])

  const run = (c: Command | undefined) => {
    if (!c) return
    onClose()
    c.run()
  }

  const optionId = (i: number) => `${listId}-${i}`

  return (
    <div
      className="modal-scrim items-start pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      data-print-hide
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="modal flex w-full max-w-lg flex-col overflow-hidden !p-0"
      >
        <h2 id={titleId} className="sr-only">
          Command palette
        </h2>
        <div className="flex items-center gap-2 border-b border-line px-3">
          <CommandIcon size={14} aria-hidden="true" className="text-muted" />
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
            className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted"
          />
        </div>
        <ul id={listId} role="listbox" aria-label="Commands" className="max-h-80 overflow-y-auto p-1">
          {results.length === 0 && <li className="px-2 py-2 text-sm text-muted">No matching command.</li>}
          {results.map((c, i) => {
            const Icon = c.icon
            return (
              <li
                key={c.id}
                id={optionId(i)}
                role="option"
                aria-selected={i === current}
                onMouseEnter={() => setActive(i)}
                onClick={() => run(c)}
                className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm ${
                  i === current ? 'bg-surface-raised' : ''
                }`}
              >
                <Icon size={14} aria-hidden="true" className="text-fiber-cyan" />
                <span className="truncate">{c.label}</span>
                <span className="ml-auto shrink-0 text-[11px] text-muted">{c.group}</span>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

/** `⌘K` / `Ctrl+K` palette: new enquiry, history, open an assessment, exports. */
export function CommandPalette({ open, ...rest }: CommandPaletteProps) {
  return open ? <Palette {...rest} /> : null
}
