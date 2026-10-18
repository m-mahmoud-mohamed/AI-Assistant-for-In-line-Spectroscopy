import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search, FolderOpen, History, House, PanelLeftClose, PanelLeftOpen, Settings, type LucideIcon } from 'lucide-react'
import { api } from '../../api'
import { storage } from '../../state/navigation'
import type { View } from '../../state/useAssessment'
import { statusLines } from './statusLines'
import { Tooltip } from './Tooltip'
import '../panel/panel.css'

export interface RailProps {
  view: View
  apiStatus: 'checking' | 'online' | 'offline'
  onHome: () => void
  onHistory: () => void
  onSources: () => void
  onSettings: () => void
  onHelp: () => void
}

function StatusDot({ apiStatus }: { apiStatus: RailProps['apiStatus'] }) {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: api.health,
    enabled: apiStatus === 'online',
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
  })
  const lines = statusLines(apiStatus, health.data)
  const dot = apiStatus === 'online' ? 'var(--status-ok)' : apiStatus === 'offline' ? 'var(--muted)' : 'var(--track)'
  return (
    <Tooltip
      label={
        <span className="tt-lines">
          {lines.map((l, i) => (
            <span key={i} data-first={i === 0}>
              {l}
            </span>
          ))}
        </span>
      }
    >
      <span role="status" aria-label={lines[0]} aria-description={lines.slice(1).join('. ') || undefined} className="rl-status" tabIndex={0}>
        <span className="rl-dot" style={{ background: dot }} />
        <span className="rl-cap" aria-hidden="true">
          PRISM
        </span>
        <span className="sr-only">{lines.join('. ')}</span>
      </span>
    </Tooltip>
  )
}

/** Icon rail: AFS emblem, navigation with a sliding active pill and bar, command palette and API status. Bottom bar below 760 px. */
export function Rail({ view, apiStatus, onHome, onHistory, onSources, onSettings, onHelp }: RailProps) {
  const [expanded, setExpanded] = useState(() => storage.get('prism:sidebar') === 'expanded')
  const items: { id: string; label: string; icon: LucideIcon; active: boolean; disabled?: boolean; onClick: () => void }[] = [
    { id: 'home', label: 'New enquiry', icon: House, active: view === 'home', onClick: onHome },
    { id: 'history', label: 'Assessments', icon: History, active: view === 'history' || view === 'thread', onClick: onHistory },
    { id: 'sources', label: 'Sources', icon: FolderOpen, active: view === 'sources', onClick: onSources },
    { id: 'settings', label: 'Settings', icon: Settings, active: view === 'settings', onClick: onSettings },
  ]
  const activeIndex = items.findIndex((it) => it.active)
  // The indicator snaps to its first position, then glides between items.
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setReady(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <nav className="rl" data-expanded={expanded} aria-label="Primary">
      <div className="rl-brand rail-in">
        <img src="/brand/afs-emblem.png" alt="Art Fiber Systems" width={36} height={36} />
      </div>
      <button className="icon-square rl-collapse" aria-label={expanded ? 'Collapse sidebar' : 'Expand sidebar'} aria-expanded={expanded} onClick={() => { setExpanded(!expanded); storage.set('prism:sidebar', expanded ? 'collapsed' : 'expanded') }}>{expanded ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}</button>
      <div
        className="rl-nav"
        data-ready={ready}
        data-has-active={activeIndex >= 0}
        style={{ ['--i' as string]: Math.max(0, activeIndex), ['--n' as string]: items.length }}
      >
        <span className="rl-ind" aria-hidden="true" />
        {items.map((it, i) => {
          const Icon = it.icon
          return (
            <Tooltip key={it.id} label={it.label}>
              <button
                type="button"
                className="rl-item rail-in"
                style={{ animationDelay: `${120 + i * 30}ms` }}
                aria-label={it.label}
                aria-current={it.active ? 'page' : undefined}
                disabled={it.disabled}
                onClick={it.onClick}
              >
                <Icon size={20} strokeWidth={1.75} aria-hidden="true" /><span className="rl-label">{it.label}</span>
              </button>
            </Tooltip>
          )
        })}
      </div>
      <div className="rl-spacer" />
      <div className="rl-bottom">
        <Tooltip
          label={
            <>
              Search and commands <kbd className="tt-kbd">Ctrl K</kbd>
            </>
          }
        >
          <button type="button" className="rl-item rail-in" style={{ animationDelay: '300ms' }} aria-label="Search and commands (⌘K)" onClick={onHelp} data-palette-origin>
            <Search size={20} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </Tooltip>
        <StatusDot apiStatus={apiStatus} />
      </div>
    </nav>
  )
}
