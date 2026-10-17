import { useCallback, useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { FileText, Network, Play } from 'lucide-react'
import { api } from './api'
import { Header, type Theme } from './components/Header'
import { NodeDetail } from './components/NodeDetail'
import { PipelineGraph } from './components/PipelineGraph'
import { RightPanel } from './components/RightPanel'
import { ReportView } from './components/report/ReportView'
import { SessionSidebar } from './components/SessionSidebar'
import { useMockRunEvents } from './hooks/useRunEvents'
import { mockCompletedEvents } from './mock/events'
import mockFindings from './mock/findings.json'
import mockReport from './mock/report.json'
import { mockSessions } from './mock/sessions'
import mockSpectral from './mock/spectral.json'
import type { ReportBody, RuleFindings, SpectralData, Stage } from './types'

const MOCK_EVENTS = mockCompletedEvents()

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

  const [selectedStage, setSelectedStage] = useState<Stage | null>(null)
  const [graphOpen, setGraphOpen] = useState(false)
  // Until runs come from the API, the pipeline shows a synthetic trace that can be replayed.
  const run = useMockRunEvents(MOCK_EVENTS)
  // While a run streams there is no report yet: show the full graph, never a blank spinner.
  const loading = run.state.status === 'running' || run.state.status === 'idle'
  const closeStage = useCallback(() => setSelectedStage(null), [])

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
        <section aria-label="Pipeline" className="mx-auto flex max-w-4xl flex-col gap-2 px-6 pt-6">
          <div className="flex items-center justify-between gap-2 text-xs text-muted">
            <span aria-live="polite">
              {loading ? 'Assessment running…' : `Pipeline ${run.state.status} (mock trace)`}
            </span>
            <div className="flex gap-2">
              {!loading && (
                <button
                  type="button"
                  onClick={() => setGraphOpen((o) => !o)}
                  aria-expanded={graphOpen}
                  className="inline-flex items-center gap-1 rounded border border-line px-2 py-1 hover:text-fg"
                >
                  <Network size={12} aria-hidden="true" /> {graphOpen ? 'Hide graph' : 'Show graph'}
                </button>
              )}
              <button
                type="button"
                onClick={run.replay}
                disabled={loading}
                className="inline-flex items-center gap-1 rounded border border-line px-2 py-1 hover:text-fg disabled:opacity-50"
              >
                <Play size={12} aria-hidden="true" /> Replay mock run
              </button>
            </div>
          </div>
          {loading || graphOpen ? (
            <PipelineGraph state={run.state} selected={selectedStage} onSelect={setSelectedStage} />
          ) : (
            <PipelineGraph state={run.state} variant="strip" selected={selectedStage} onSelect={setSelectedStage} />
          )}
        </section>
        {!loading && (
          <ReportView
            report={mockReport as ReportBody}
            spectral={mockSpectral as unknown as SpectralData}
            rules={mockFindings as RuleFindings}
            notice={
              <>
                <FileText size={14} aria-hidden="true" /> Mock report (no backend connected)
              </>
            }
          />
        )}
      </main>
      {selectedStage && <NodeDetail stage={selectedStage} state={run.state.stages[selectedStage]} onClose={closeStage} />}
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
