import { CircleHelp, FolderOpen, History, House, MessageCircle, Network, type LucideIcon } from 'lucide-react'
import type { View } from '../../state/useAssessment'

export interface RailProps {
  view: View
  hasThread: boolean
  hasRun: boolean
  hasReport: boolean
  apiStatus: 'checking' | 'online' | 'offline'
  onHome: () => void
  onThread: () => void
  onHistory: () => void
  onPipeline: () => void
  onSources: () => void
  onHelp: () => void
}

const STATUS_TEXT = {
  checking: 'Checking the PRISM API…',
  online: 'PRISM API connected',
  offline: "PRISM API not reachable — start it with `make api`",
} as const

/** Icon rail: AFS emblem, navigation, command palette and API status. Becomes a bottom bar below 760 px. */
export function Rail({ view, hasThread, hasRun, hasReport, apiStatus, onHome, onThread, onHistory, onPipeline, onSources, onHelp }: RailProps) {
  const items: { id: string; label: string; icon: LucideIcon; active: boolean; disabled?: boolean; onClick: () => void }[] = [
    { id: 'home', label: 'New enquiry', icon: House, active: view === 'home', onClick: onHome },
    { id: 'thread', label: 'Current assessment', icon: MessageCircle, active: view === 'thread', disabled: !hasThread, onClick: onThread },
    { id: 'history', label: 'History', icon: History, active: view === 'history', onClick: onHistory },
    { id: 'pipeline', label: 'Pipeline graph', icon: Network, active: false, disabled: !hasRun, onClick: onPipeline },
    { id: 'sources', label: 'Sources', icon: FolderOpen, active: false, disabled: !hasReport, onClick: onSources },
  ]
  const dot = apiStatus === 'online' ? '#0f9d6b' : apiStatus === 'offline' ? '#a1a4ae' : '#d4d6de'
  return (
    <nav className="rail" aria-label="Primary">
      <div className="rail-brand rail-in">
        <img src="/brand/afs-emblem.png" alt="Art Fiber Systems" width={36} height={36} style={{ display: 'block', width: 36, height: 36, objectFit: 'contain' }} />
      </div>
      <div className="rail-nav">
        {items.map((it, i) => {
          const Icon = it.icon
          return (
            <button
              key={it.id}
              type="button"
              className="rail-item rail-in"
              style={{ animationDelay: `${120 + i * 30}ms` }}
              aria-label={it.label}
              title={it.label}
              aria-current={it.active ? 'page' : undefined}
              disabled={it.disabled}
              onClick={it.onClick}
            >
              <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )
        })}
      </div>
      <div className="rail-spacer" />
      <div className="rail-bottom-only">
        <button type="button" className="rail-item rail-in" style={{ animationDelay: '300ms' }} aria-label="Search and commands (⌘K)" title="Search and commands (⌘K)" onClick={onHelp}>
          <CircleHelp size={20} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <span
          role="status"
          aria-label={STATUS_TEXT[apiStatus]}
          title={STATUS_TEXT[apiStatus]}
          style={{ display: 'grid', placeItems: 'center', width: 36, height: 36 }}
        >
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot, transition: 'background-color 300ms ease' }} />
        </span>
      </div>
    </nav>
  )
}
