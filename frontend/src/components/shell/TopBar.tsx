import { Moon, Sun } from 'lucide-react'
import { useAppearance } from '../../features/settings/appearance'
import { Dropdown } from './Dropdown'

export interface TopBarProps {
  crumb: string
}

/** Session context and appearance; report versions and report actions live in the report header. */
export function TopBar({ crumb }: TopBarProps) {
  const { appearance, setAppearance } = useAppearance()
  return <header className="topbar" data-print-hide>
    <span className="shell-title">PRISM</span>
    <span className="crumb-title">{crumb}</span>
    <div className="topbar-actions">
      <Dropdown ariaLabel="Appearance" className="icon-square" chevron={false} align="right" items={(['light', 'dark', 'system'] as const).map((value) => ({
        id: value, label: value[0].toUpperCase() + value.slice(1), checked: appearance === value, onSelect: () => setAppearance(value),
      }))}>{appearance === 'dark' ? <Moon size={17} aria-hidden="true" /> : <Sun size={17} aria-hidden="true" />}</Dropdown>
    </div>
  </header>
}
