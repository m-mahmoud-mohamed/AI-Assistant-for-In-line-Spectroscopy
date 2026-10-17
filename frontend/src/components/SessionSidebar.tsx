import { useMemo, useState } from 'react'
import { FlaskConical, Loader2, Plus, Search, Target, User } from 'lucide-react'
import { SESSION_GROUPS, groupSidebar, type SidebarItem } from '../sessions'
import type { CaseInfo, Session } from '../types'
import { DemoBadge } from './DemoBadge'

const GROUP_ICON = { Dev: FlaskConical, Eval: Target, Mine: User } as const

interface SessionSidebarProps {
  /** Case files (`GET /api/cases`): Dev and Eval groups. Clicking one starts a new run. */
  cases: CaseInfo[]
  /** Stored sessions (`GET /api/sessions`): the Mine group. */
  sessions: Session[]
  loading?: boolean
  notice?: string
  /** Mock entries are shown (backend offline). */
  demo?: boolean
  selectedId?: string | null
  /** Case whose session is being created / run started. */
  startingCaseId?: string | null
  onSelect: (id: string) => void
  onSelectCase: (caseId: string) => void
  onNewEnquiry: () => void
  open: boolean
}

export function SessionSidebar({
  cases,
  sessions,
  loading,
  notice,
  demo,
  selectedId,
  startingCaseId,
  onSelect,
  onSelectCase,
  onNewEnquiry,
  open,
}: SessionSidebarProps) {
  const [query, setQuery] = useState('')
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const match = (caseId: string | null, title: string) => !q || `${caseId ?? ''} ${title}`.toLowerCase().includes(q)
    return groupSidebar(
      cases.filter((c) => match(c.case_id, c.title)),
      sessions.filter((s) => match(s.case_id, s.title)),
    )
  }, [cases, sessions, query])

  const itemButton = (item: SidebarItem) => {
    const selected = item.kind === 'session' && item.id === selectedId
    const starting = item.kind === 'case' && item.case_id === startingCaseId
    return (
      <button
        type="button"
        onClick={() => (item.kind === 'case' ? onSelectCase(item.case_id) : onSelect(item.id))}
        disabled={!!startingCaseId}
        aria-current={selected ? 'true' : undefined}
        aria-busy={starting || undefined}
        title={item.kind === 'case' ? `Run ${item.case_id} as a new session` : undefined}
        className={`flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-raised disabled:opacity-60 ${
          selected ? 'bg-surface-raised font-semibold' : ''
        }`}
      >
        {item.case_id && <span className="font-mono text-xs text-fiber-cyan">{item.case_id}</span>}
        <span className="truncate">{item.title || 'Untitled enquiry'}</span>
        {starting && <Loader2 size={12} aria-label="Starting" className="ml-auto shrink-0 animate-spin" />}
      </button>
    )
  }

  return (
    <nav id="session-sidebar" className="app-sidebar flex flex-col gap-3 p-3" data-open={open} aria-label="Sessions">
      <h2 className="flex items-center gap-2 px-1 text-xs font-bold uppercase tracking-[0.16em] text-muted">
        Sessions {demo && <DemoBadge />}
      </h2>

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
              <p className="px-1 text-xs text-muted">{group === 'Mine' ? 'No sessions' : 'No cases'}</p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {groups[group].map((item) => (
                  <li key={item.key}>{itemButton(item)}</li>
                ))}
              </ul>
            )}
          </section>
        )
      })}
    </nav>
  )
}
