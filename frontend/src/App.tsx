import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { Braces, FileText, FilePlus, FolderOpen, Mail, Network, Play, Printer } from 'lucide-react'
import { api, isOffline } from './api'
import { ChatPanel } from './components/ChatPanel'
import { CommandPalette, type Command } from './components/CommandPalette'
import { EmailDraftModal } from './components/EmailDraftModal'
import { EnquiryEditor } from './components/EnquiryEditor'
import { EvidenceViewer } from './components/EvidenceViewer'
import { ExportMenu } from './components/ExportMenu'
import { Header, type Theme } from './components/Header'
import { NodeDetail } from './components/NodeDetail'
import { PipelineGraph } from './components/PipelineGraph'
import { RefusalCard } from './components/RefusalCard'
import { RightPanel } from './components/RightPanel'
import { ReportView, type ReportViewData } from './components/report/ReportView'
import { SessionSidebar } from './components/SessionSidebar'
import { SuggestionChips } from './components/SuggestionChips'
import { downloadJson, downloadMarkdown, printReport } from './export'
import { useMockRunEvents, useRunEvents } from './hooks/useRunEvents'
import { mockCompletedEvents } from './mock/events'
import mockFindings from './mock/findings.json'
import mockReport from './mock/report.json'
import { mockSessions } from './mock/sessions'
import mockSpectral from './mock/spectral.json'
import { reportSuggestions } from './suggestions'
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
  const closeStage = useCallback(() => setSelectedStage(null), [])

  // Enquiry editor ("New enquiry"), evidence selection, chat input, palette and e-mail modal.
  const [composing, setComposing] = useState(false)
  const [enquiry, setEnquiry] = useState('')
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [citedId, setCitedId] = useState<string | null>(null)
  const [chatDraft, setChatDraft] = useState('')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [emailOpen, setEmailOpen] = useState(false)
  const enquiryRef = useRef<HTMLTextAreaElement>(null)

  const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.listSessions, retry: false })
  const offline = sessions.isError
  const sessionList = useMemo(() => (offline ? mockSessions : (sessions.data ?? [])), [offline, sessions.data])

  // The run shown in the main column: one started here or from the chat, else the session's latest report.
  const session = useQuery({
    queryKey: ['session', selectedId],
    queryFn: () => api.getSession(selectedId!),
    enabled: !!selectedId,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })
  const [runOverride, setRunOverride] = useState<{ sessionId: string; runId: string } | null>(null)
  const latestStored = session.data?.reports?.reduce<{ version: number; run_id: string } | null>(
    (best, r) => (!best || r.version > best.version ? r : best),
    null,
  )
  const activeRunId = (runOverride?.sessionId === selectedId ? runOverride?.runId : null) ?? latestStored?.run_id ?? null

  const liveRun = useRunEvents(activeRunId)
  // Until a real run is selected, the pipeline shows a synthetic trace that can be replayed.
  const mockRun = useMockRunEvents(MOCK_EVENTS)
  const run = activeRunId ? liveRun : mockRun
  // While a run streams there is no report yet: show the full graph, never a blank spinner.
  const loading = run.state.status === 'running' || run.state.status === 'idle'

  const liveReport = useQuery({
    queryKey: ['report', activeRunId],
    queryFn: () => api.getReport(activeRunId!),
    enabled: !!activeRunId && liveRun.state.status === 'completed',
    retry: false,
  })
  const usingMock = !activeRunId || !liveReport.data
  const report: ReportViewData = liveReport.data ?? (mockReport as ReportBody)
  const citations = useMemo(() => Object.fromEntries((report.sources ?? []).map((s) => [s.id, s.citation])), [report.sources])

  const closeOverlays = () => {
    setSidebarOpen(false)
    setPanelOpen(false)
  }

  const newEnquiry = useCallback((text?: string) => {
    setSelectedId(null)
    setComposing(true)
    setStartError(null)
    if (text !== undefined) setEnquiry(text)
    setSidebarOpen(false)
    setTimeout(() => enquiryRef.current?.focus(), 0)
  }, [])

  const openSession = useCallback((id: string) => {
    setSelectedId(id)
    setComposing(false)
    setCitedId(null)
    setSidebarOpen(false)
  }, [])

  const startAssessment = async (text: string) => {
    setStarting(true)
    setStartError(null)
    try {
      const created = await api.createSession(text)
      const started = await api.startRun(created.id)
      setSelectedId(created.id)
      setRunOverride({ sessionId: created.id, runId: started.run_id })
      setComposing(false)
      void sessions.refetch()
    } catch (err) {
      setStartError(
        isOffline(err) ? 'Backend offline: start the API (make api) to run an assessment.' : `Could not start: ${String(err)}`,
      )
    } finally {
      setStarting(false)
    }
  }

  const cite = (cardId: string) => {
    setCitedId(cardId)
    setPanelOpen(true)
  }

  const fillChat = (text: string) => {
    setChatDraft(text)
    setPanelOpen(true)
  }

  // ⌘K / Ctrl+K toggles the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const commands: Command[] = useMemo(
    () => [
      { id: 'new', group: 'Enquiry', label: 'New enquiry', icon: FilePlus, run: () => newEnquiry() },
      ...sessionList.map((s) => ({
        id: `open-${s.id}`,
        group: 'Open case',
        label: s.case_id ? `${s.case_id} · ${s.title}` : s.title || 'Untitled enquiry',
        keywords: 'open case session',
        icon: FolderOpen,
        run: () => openSession(s.id),
      })),
      { id: 'md', group: 'Export', label: 'Download Markdown', icon: FileText, run: () => void downloadMarkdown(report, activeRunId) },
      { id: 'json', group: 'Export', label: 'Download JSON', icon: Braces, run: () => downloadJson(report) },
      { id: 'print', group: 'Export', label: 'Print / save as PDF', icon: Printer, run: printReport },
      { id: 'email', group: 'Export', label: 'Customer e-mail draft', icon: Mail, run: () => setEmailOpen(true) },
    ],
    [sessionList, report, activeRunId, newEnquiry, openSession],
  )

  const refusal = activeRunId && liveRun.state.status === 'refused' ? liveRun.state.refusal : null

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
        onSelect={openSession}
        onNewEnquiry={() => newEnquiry()}
        open={sidebarOpen}
      />
      <main className="app-main">
        {composing ? (
          <section aria-label="New enquiry" className="mx-auto flex max-w-4xl flex-col gap-3 p-6">
            <EnquiryEditor
              ref={enquiryRef}
              value={enquiry}
              onChange={setEnquiry}
              onSubmit={startAssessment}
              busy={starting}
              error={startError}
            />
          </section>
        ) : (
          <>
            <section aria-label="Pipeline" className="mx-auto flex max-w-4xl flex-col gap-2 px-6 pt-6">
              <div className="flex items-center justify-between gap-2 text-xs text-muted">
                <span aria-live="polite">
                  {loading
                    ? 'Assessment running…'
                    : `Pipeline ${run.state.status}${activeRunId ? '' : ' (mock trace)'}`}
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
                  {!activeRunId && (
                    <button
                      type="button"
                      onClick={mockRun.replay}
                      disabled={loading}
                      className="inline-flex items-center gap-1 rounded border border-line px-2 py-1 hover:text-fg disabled:opacity-50"
                    >
                      <Play size={12} aria-hidden="true" /> Replay mock run
                    </button>
                  )}
                  {!loading && !refusal && (
                    <ExportMenu report={report} runId={activeRunId} onEmailDraft={() => setEmailOpen(true)} />
                  )}
                </div>
              </div>
              {loading || graphOpen ? (
                <PipelineGraph state={run.state} selected={selectedStage} onSelect={setSelectedStage} />
              ) : (
                <PipelineGraph state={run.state} variant="strip" selected={selectedStage} onSelect={setSelectedStage} />
              )}
            </section>
            {refusal ? (
              <div className="mx-auto max-w-4xl p-6">
                <RefusalCard
                  reason={refusal.reason}
                  label={refusal.label}
                  suggestions={refusal.suggestions}
                  onExample={(text) => newEnquiry(text)}
                />
              </div>
            ) : (
              !loading && (
                <>
                  <ReportView
                    report={report}
                    spectral={mockSpectral as unknown as SpectralData}
                    rules={usingMock ? (mockFindings as RuleFindings) : undefined}
                    onCite={cite}
                    notice={
                      usingMock ? (
                        <>
                          <FileText size={14} aria-hidden="true" /> Mock report (no backend connected)
                        </>
                      ) : undefined
                    }
                  />
                  <div className="mx-auto flex max-w-4xl flex-col gap-2 px-6 pb-6" data-print-hide>
                    <p className="text-xs text-muted">Follow up in the chat:</p>
                    <SuggestionChips suggestions={reportSuggestions(report)} onPick={fillChat} label="Report suggestions" />
                  </div>
                </>
              )
            )}
          </>
        )}
      </main>
      {selectedStage && <NodeDetail stage={selectedStage} state={run.state.stages[selectedStage]} onClose={closeStage} />}
      <RightPanel
        open={panelOpen}
        onToggle={() => setPanelOpen((o) => !o)}
        evidence={
          citedId ? (
            <EvidenceViewer
              cardId={citedId}
              fallback={report.sources?.find((s) => s.id === citedId)}
              onClose={() => setCitedId(null)}
            />
          ) : undefined
        }
        chat={
          <ChatPanel
            sessionId={selectedId}
            report={report}
            citations={citations}
            onCite={cite}
            value={chatDraft}
            onValueChange={setChatDraft}
            onRunStarted={(runId) => selectedId && setRunOverride({ sessionId: selectedId, runId })}
          />
        }
      />
      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
      <EmailDraftModal
        open={emailOpen}
        sessionId={selectedId}
        runId={activeRunId}
        report={report}
        onClose={() => setEmailOpen(false)}
      />
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
