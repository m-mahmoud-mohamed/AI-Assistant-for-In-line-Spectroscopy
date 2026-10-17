import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Check, ChevronDown, type LucideIcon } from 'lucide-react'

export interface DropdownItem {
  id: string
  label: ReactNode
  icon?: LucideIcon
  /** When defined the item is a radio-style option and shows a check while true. */
  checked?: boolean
  disabled?: boolean
  /** Draw a hairline above this item. */
  separatorBefore?: boolean
  onSelect: () => void
}

interface DropdownProps {
  /** Button content (icon + label). */
  children: ReactNode
  ariaLabel: string
  items: DropdownItem[]
  align?: 'left' | 'right'
  disabled?: boolean
  className?: string
  chevron?: boolean
  title?: string
}

/** A secondary button that opens a keyboard-navigable menu (arrows, Home/End, Escape, outside click). */
export function Dropdown({ children, ariaLabel, items, align = 'left', disabled, className = 'btn', chevron = true, title }: DropdownProps) {
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const rootRef = useRef<HTMLDivElement>(null)
  const itemsRef = useRef(items)
  useEffect(() => {
    itemsRef.current = items
  })

  useEffect(() => {
    if (!open) return
    itemRefs.current[Math.max(0, itemsRef.current.findIndex((i) => i.checked))]?.focus()
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
    const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0)
    const pos = enabled.indexOf(index)
    const move = (to: number | undefined) => {
      if (to === undefined) return
      e.preventDefault()
      itemRefs.current[to]?.focus()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'Tab') setOpen(false)
    else if (e.key === 'ArrowDown') move(enabled[(pos + 1) % enabled.length])
    else if (e.key === 'ArrowUp') move(enabled[(pos - 1 + enabled.length) % enabled.length])
    else if (e.key === 'Home') move(enabled[0])
    else if (e.key === 'End') move(enabled[enabled.length - 1])
  }

  return (
    <div ref={rootRef} style={{ position: 'relative' }} data-print-hide>
      <button
        ref={buttonRef}
        type="button"
        className={className}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        {children}
        {chevron && <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" style={{ color: 'var(--muted)' }} />}
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={ariaLabel}
          className="menu"
          style={{ top: 'calc(100% + 6px)', [align === 'right' ? 'right' : 'left']: 0, ['--origin' as string]: align === 'right' ? 'top right' : 'top left' }}
        >
          {items.map((item, i) => {
            const Icon = item.icon
            const radio = item.checked !== undefined
            return (
              <div key={item.id}>
                {item.separatorBefore && <div style={{ height: 1, margin: '6px 4px', background: 'var(--hairline)' }} role="separator" />}
                <button
                  ref={(el) => {
                    itemRefs.current[i] = el
                  }}
                  type="button"
                  role={radio ? 'menuitemradio' : 'menuitem'}
                  aria-checked={radio ? item.checked : undefined}
                  disabled={item.disabled}
                  tabIndex={-1}
                  className="menu-item"
                  style={item.disabled ? { opacity: 0.5, cursor: 'default' } : undefined}
                  onKeyDown={(e) => onMenuKey(e, i)}
                  onClick={() => {
                    close()
                    item.onSelect()
                  }}
                >
                  {Icon && <Icon size={16} strokeWidth={1.75} aria-hidden="true" style={{ color: 'var(--violet)' }} />}
                  <span style={{ flex: 1 }}>{item.label}</span>
                  {item.checked && <Check size={14} strokeWidth={2} aria-hidden="true" style={{ color: 'var(--violet)' }} />}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
