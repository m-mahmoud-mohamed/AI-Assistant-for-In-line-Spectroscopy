import { useMemo, useState } from 'react'
import { FlaskConical, Plus, Search, Target, User } from 'lucide-react'
import { SESSION_GROUPS, groupSessions } from '../sessions'
import type { Session } from '../types'

const GROUP_ICON = { Dev: FlaskConical, Eval: Target, Mine: User } as const

interface SessionSidebarProps {
  sessions: Session[]
  loading?: boolean
  notice?: string
  selectedId?: string | null
  onSelect: (id: string) => void
  onNewEnquiry: () => void
  open: boolean
}

export function SessionSidebar({
  sessions,
  loading,
  notice,
  selectedId,
  onSelect,
  onNewEnquiry,
  open,
}: SessionSidebarProps) {
  const [query, setQuery] = useState('')
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? sessions.filter((s) => `${s.case_id ?? ''} ${s.title}`.toLowerCase().includes(q))
      : sessions
    return groupSessions(filtered)
  }, [sessions, query])

  return (
    <nav id="session-sidebar" className="app-sidebar flex flex-col gap-3 p-3" data-open={open} aria-label="Sessions">
      <h2 className="px-1 text-xs font-bold uppercase tracking-[0.16em] text-muted">Sessions</h2>

      <label className="flex items-center gap-2 rounded-md border border-line bg-surface-raised px-2">
        <Search size={14} aria-hidden="true" className="text-muted" />
        <span className="sr-only">Search sessions</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search"
          className="h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted"
        />
      </label>

      <button
        type="button"
        onClick={onNewEnquiry}
        className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-prism-600 text-sm font-semibold text-white hover:bg-prism-500"
      >
        <Plus size={16} aria-hidden="true" /> New enquiry
      </button>

      {notice && (
        <p role="status" className="rounded-md border border-line px-2 py-1 text-xs text-muted">
          {notice}
        </p>
      )}
      {loading && (
        <p role="status" className="px-1 text-xs text-muted">
          Loading sessions…
        </p>
      )}

      {SESSION_GROUPS.map((group) => {
        const Icon = GROUP_ICON[group]
        const headingId = `session-group-${group.toLowerCase()}`
        return (
          <section key={group} aria-labelledby={headingId}>
            <h3
              id={headingId}
              className="mb-1 flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted"
            >
              <Icon size={12} aria-hidden="true" />
              {group}
            </h3>
            {groups[group].length === 0 ? (
              <p className="px-1 text-xs text-muted">No sessions</p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {groups[group].map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(s.id)}
                      aria-current={s.id === selectedId ? 'true' : undefined}
                      className={`flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-raised ${
                        s.id === selectedId ? 'bg-surface-raised font-semibold' : ''
                      }`}
                    >
                      {s.case_id && <span className="font-mono text-xs text-fiber-cyan">{s.case_id}</span>}
                      <span className="truncate">{s.title || 'Untitled enquiry'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )
      })}
    </nav>
  )
}
