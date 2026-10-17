import { useCallback, useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { FileText } from 'lucide-react'
import { api } from './api'
import { Header, type Theme } from './components/Header'
import { RightPanel } from './components/RightPanel'
import { ReportView } from './components/report/ReportView'
import { SessionSidebar } from './components/SessionSidebar'
import mockReport from './mock/report.json'
import { mockSessions } from './mock/sessions'
import type { ReportBody } from './types'

const THEME_KEY = 'prism-theme'

function initialTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(initialTheme)
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      // storage unavailable (private mode): theme still applies for this page
    }
  }, [theme])
  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), [])
  return [theme, toggle]
}

// ---------------------------------------------------------------- shell

function Shell() {
  const [theme, toggleTheme] = useTheme()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.listSessions, retry: false })
  const offline = sessions.isError
  const sessionList = offline ? mockSessions : (sessions.data ?? [])

  const closeOverlays = () => {
    setSidebarOpen(false)
    setPanelOpen(false)
  }

  return (
    <div className="app-shell">
      <Header
        theme={theme}
        onToggleTheme={toggleTheme}
        onToggleSidebar={() => {
          setPanelOpen(false)
          setSidebarOpen((o) => !o)
        }}
        onTogglePanel={() => {
          setSidebarOpen(false)
          setPanelOpen((o) => !o)
        }}
        sidebarOpen={sidebarOpen}
        panelOpen={panelOpen}
      />
      <SessionSidebar
        sessions={sessionList}
        loading={sessions.isPending}
        notice={offline ? 'Backend offline: showing mock sessions.' : undefined}
        selectedId={selectedId}
        onSelect={(id) => {
          setSelectedId(id)
          setSidebarOpen(false)
        }}
        onNewEnquiry={() => setSelectedId(null)}
        open={sidebarOpen}
      />
      <main className="app-main">
        <ReportView
          report={mockReport as ReportBody}
          notice={
            <>
              <FileText size={14} aria-hidden="true" /> Mock report (no backend connected)
            </>
          }
        />
      </main>
      <RightPanel open={panelOpen} onToggle={() => setPanelOpen((o) => !o)} />
      <div className="app-backdrop" data-open={sidebarOpen || panelOpen} onClick={closeOverlays} aria-hidden="true" />
    </div>
  )
}

export default function App({ queryClient }: { queryClient?: QueryClient }) {
  const [client] = useState(() => queryClient ?? new QueryClient())
  return (
    <QueryClientProvider client={client}>
      <Shell />
    </QueryClientProvider>
  )
}
