import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Braces, ChevronDown, Download, FileText, Mail, Printer, type LucideIcon } from 'lucide-react'
import { downloadJson, downloadMarkdown, printReport } from '../export'
import type { ReportViewData } from './report/ReportView'

interface ExportMenuProps {
  report: ReportViewData
  runId?: string | null
  onEmailDraft: () => void
}

interface Item {
  label: string
  icon: LucideIcon
  run: () => void
}

/** Markdown / JSON download, print to PDF and the customer e-mail draft. */
export function ExportMenu({ report, runId, onEmailDraft }: ExportMenuProps) {
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const rootRef = useRef<HTMLDivElement>(null)

  const items: Item[] = [
    { label: 'Download Markdown', icon: FileText, run: () => void downloadMarkdown(report, runId) },
    { label: 'Download JSON', icon: Braces, run: () => downloadJson(report) },
    { label: 'Print / save as PDF', icon: Printer, run: printReport },
    { label: 'Customer e-mail draft', icon: Mail, run: onEmailDraft },
  ]

  useEffect(() => {
    if (!open) return
    itemRefs.current[0]?.focus()
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const close = () => {
    setOpen(false)
    buttonRef.current?.focus()
  }

  const onMenuKey = (e: KeyboardEvent, index: number) => {
    const n = items.length
    const next =
      e.key === 'ArrowDown' ? (index + 1) % n
      : e.key === 'ArrowUp' ? (index - 1 + n) % n
      : e.key === 'Home' ? 0
      : e.key === 'End' ? n - 1
      : null
    if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.preventDefault()
      close()
      return
    }
    if (next === null) return
    e.preventDefault()
    itemRefs.current[next]?.focus()
  }

  return (
    <div ref={rootRef} className="relative" data-print-hide>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 rounded border border-line px-2 py-1 hover:text-fg"
      >
        <Download size={12} aria-hidden="true" /> Export <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Export"
          className="absolute right-0 z-30 mt-1 flex w-56 flex-col rounded-md border border-line bg-surface p-1 shadow-lg"
        >
          {items.map((item, i) => {
            const Icon = item.icon
            return (
              <button
                key={item.label}
                ref={(el) => {
                  itemRefs.current[i] = el
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                onKeyDown={(e) => onMenuKey(e, i)}
                onClick={() => {
                  close()
                  item.run()
                }}
                className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-fg hover:bg-surface-raised focus:bg-surface-raised"
              >
                <Icon size={14} aria-hidden="true" className="text-fiber-cyan" /> {item.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
