import { useState } from 'react'
import { Menu, Moon, PanelRight, Sun } from 'lucide-react'

export type Theme = 'dark' | 'light'

interface HeaderProps {
  theme: Theme
  onToggleTheme: () => void
  onToggleSidebar: () => void
  onTogglePanel: () => void
  sidebarOpen: boolean
  panelOpen: boolean
  profile?: string
}

const iconButton =
  'inline-flex h-9 items-center gap-2 rounded-md border border-white/20 px-3 text-sm font-medium text-white hover:bg-white/10'

export function Header({
  theme,
  onToggleTheme,
  onToggleSidebar,
  onTogglePanel,
  sidebarOpen,
  panelOpen,
  profile,
}: HeaderProps) {
  const [logoFailed, setLogoFailed] = useState(false)
  const nextTheme = theme === 'dark' ? 'light' : 'dark'

  return (
    <header className="app-header flex items-center gap-3 px-4">
      <button
        type="button"
        className={`${iconButton} narrow-only`}
        onClick={onToggleSidebar}
        aria-label="Sessions"
        aria-expanded={sidebarOpen}
        aria-controls="session-sidebar"
      >
        <Menu size={18} aria-hidden="true" />
      </button>

      {logoFailed ? (
        <span className="text-lg font-extrabold tracking-wide text-white" role="img" aria-label="Art Fiber Systems">
          AFS
        </span>
      ) : (
        <img
          src="/brand/afs-logo-white.png"
          alt="Art Fiber Systems"
          className="h-9 w-auto"
          onError={() => setLogoFailed(true)}
        />
      )}

      <div className="flex min-w-0 items-baseline gap-2">
        <h1 className="text-xl font-extrabold tracking-[0.18em] text-white">PRISM</h1>
        <span className="hidden truncate text-sm text-white/70 md:inline">· In-line Spectroscopy Assessment</span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        {profile && (
          <span className="hidden rounded-md border border-white/20 px-2 py-1 font-mono text-xs text-white/80 sm:inline">
            Profile: {profile}
          </span>
        )}
        <button
          type="button"
          className={iconButton}
          onClick={onToggleTheme}
          aria-label={`Switch to ${nextTheme} theme`}
          title={`Switch to ${nextTheme} theme`}
        >
          {theme === 'dark' ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
          <span className="hidden sm:inline">{theme === 'dark' ? 'Light' : 'Dark'}</span>
        </button>
        <button
          type="button"
          className={`${iconButton} narrow-only`}
          onClick={onTogglePanel}
          aria-label="Evidence and chat"
          aria-expanded={panelOpen}
          aria-controls="right-panel"
        >
          <PanelRight size={18} aria-hidden="true" />
        </button>
      </div>
    </header>
  )
}
