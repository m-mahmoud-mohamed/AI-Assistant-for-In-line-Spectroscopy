import { GitCompare, Moon, Sun } from 'lucide-react'
import type { ReportVersion } from '../../types'
import { useAppearance } from '../../features/settings/appearance'
import { Dropdown } from './Dropdown'

export interface TopBarProps {
  versions: ReportVersion[]
  currentVersion: number | null
  previousVersion: number | null
  onSelectVersion: (version: number) => void
  onCompare: () => void
  crumb: string
}

/** Session context and report versions; report actions live in the report header. */
export function TopBar({ versions, currentVersion, previousVersion, onSelectVersion, onCompare, crumb }: TopBarProps) {
  const { appearance, setAppearance } = useAppearance()
  return <header className="topbar" data-print-hide>
    <span className="shell-title">PRISM</span>
    <span className="crumb-title">{crumb}</span>
    <div className="topbar-actions">
      {currentVersion !== null && <Dropdown ariaLabel="Report version" items={[
        ...[...versions].reverse().map((v) => ({ id: `v${v.version}`, label: `Report v${v.version}`, checked: currentVersion === v.version, onSelect: () => onSelectVersion(v.version) })),
        { id: 'compare', label: 'Compare with previous', icon: GitCompare, disabled: previousVersion === null, onSelect: onCompare },
      ]}><span>Report v{currentVersion}</span></Dropdown>}
      <Dropdown ariaLabel="Appearance" className="icon-square" chevron={false} align="right" items={(['light', 'dark', 'system'] as const).map((value) => ({
        id: value, label: value[0].toUpperCase() + value.slice(1), checked: appearance === value, onSelect: () => setAppearance(value),
      }))}>{appearance === 'dark' ? <Moon size={17} aria-hidden="true" /> : <Sun size={17} aria-hidden="true" />}</Dropdown>
    </div>
  </header>
}
