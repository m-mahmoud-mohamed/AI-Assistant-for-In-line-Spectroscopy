import { GitCompare, PanelRight, Plus, Search, SlidersHorizontal, Sparkles } from 'lucide-react'
import { useTypewriter } from '../../motion'
import type { ReportViewData } from '../report/ReportView'
import type { ReportVersion } from '../../types'
import { ExportMenu } from '../ExportMenu'
import { Dropdown, type DropdownItem } from './Dropdown'

export interface TopBarProps {
  deep: boolean
  onDeepChange: (deep: boolean) => void
  versions: ReportVersion[]
  currentVersion: number | null
  /** Version the "Compare with previous" item diffs against; null disables it. */
  previousVersion: number | null
  onSelectVersion: (version: number) => void
  onCompare: () => void
  /** Breadcrumb tail: the session title, "History", or empty on home. */
  crumb: string
  onCrumbClick: () => void
  onSearch: () => void
  report: ReportViewData | null
  runId: string | null
  onEmailDraft: () => void
  onNewEnquiry: () => void
  /** Show the slide-over toggle (thread below 1180 px). */
  showPanelToggle: boolean
  onTogglePanel: () => void
  panelOpen: boolean
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '')

/** Top bar: mode + version selects, breadcrumb with typed title, search, export, black New enquiry. */
export function TopBar({
  deep,
  onDeepChange,
  versions,
  currentVersion,
  previousVersion,
  onSelectVersion,
  onCompare,
  crumb,
  onCrumbClick,
  onSearch,
  report,
  runId,
  onEmailDraft,
  onNewEnquiry,
  showPanelToggle,
  onTogglePanel,
  panelOpen,
}: TopBarProps) {
  const typed = useTypewriter(crumb, 28)

  const modeItems: DropdownItem[] = [
    { id: 'standard', label: 'Standard', checked: !deep, onSelect: () => onDeepChange(false) },
    { id: 'deep', label: 'Deep', checked: deep, onSelect: () => onDeepChange(true) },
  ]
  const versionItems: DropdownItem[] = [
    ...[...versions].reverse().map((v) => ({
      id: `v${v.version}`,
      label: `Report v${v.version}`,
      checked: v.version === currentVersion,
      onSelect: () => onSelectVersion(v.version),
    })),
    {
      id: 'compare',
      label: 'Compare with previous',
      icon: GitCompare,
      disabled: previousVersion === null,
      separatorBefore: versions.length > 0,
      onSelect: onCompare,
    },
  ]
  const hasVersion = currentVersion !== null
  const versionLabel = hasVersion ? `Report v${currentVersion}` : 'Report'

  // Below 760 px the two selects collapse into one options menu.
  const compactItems: DropdownItem[] = [
    ...modeItems.map((m) => ({ ...m, label: `Mode: ${m.label}` })),
    ...(hasVersion ? versionItems.map((v, i) => ({ ...v, separatorBefore: i === 0 || v.separatorBefore })) : []),
  ]

  return (
    <header className="topbar" data-print-hide>
      <div className="topbar-selects hide-sm">
        <Dropdown ariaLabel="Reasoning mode" items={modeItems}>
          <Sparkles size={16} strokeWidth={1.75} aria-hidden="true" style={{ color: 'var(--violet)' }} />
          <span>{deep ? 'Deep' : 'Standard'}</span>
        </Dropdown>
        <Dropdown ariaLabel="Report version" items={versionItems} disabled={!hasVersion} title={hasVersion ? undefined : 'Available once an assessment exists'}>
          <span>{versionLabel}</span>
        </Dropdown>
      </div>
      <div className="show-sm">
        <Dropdown ariaLabel="Options" items={compactItems} chevron={false} className="btn" >
          <SlidersHorizontal size={16} strokeWidth={1.75} aria-hidden="true" />
        </Dropdown>
      </div>

      <div className="crumb">
        <button type="button" className="crumb-link" onClick={onCrumbClick} title="All assessments">
          <Plus size={18} strokeWidth={1.75} aria-hidden="true" />
          <span>Assessments</span>
        </button>
        {crumb && (
          <>
            <span aria-hidden="true" style={{ color: 'var(--muted)' }}>
              /
            </span>
            <span className="crumb-title" aria-label={crumb}>
              <span aria-hidden="true">{typed}</span>
            </span>
          </>
        )}
      </div>

      <div className="topbar-actions">
        <button type="button" className="btn" onClick={onSearch} aria-label="Search" title={`Search (${isMac ? '⌘' : 'Ctrl+'}K)`} data-palette-origin>
          <Search size={16} strokeWidth={1.75} aria-hidden="true" />
          <span className="btn-label">Search</span>
          <kbd className="kbd hide-md">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
        <ExportMenu report={report} runId={runId} onEmailDraft={onEmailDraft} labelClassName="btn-label" />
        {showPanelToggle && (
          <button
            type="button"
            className="btn panel-slideover-btn"
            aria-label="Sources and suggestions"
            aria-expanded={panelOpen}
            aria-controls="side-panel"
            onClick={onTogglePanel}
          >
            <PanelRight size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}
        <button type="button" className="btn btn-primary" onClick={onNewEnquiry}>
          <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
          <span className="btn-label">New enquiry</span>
        </button>
      </div>
    </header>
  )
}
