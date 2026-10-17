import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { Braces, CircleAlert, FileText, FilePlus, FolderOpen, Loader2, Mail, Network, Play, Printer } from 'lucide-react'
import { api, isOffline, isStillRunning } from './api'
import { ChatPanel } from './components/ChatPanel'
import { CommandPalette, type Command } from './components/CommandPalette'
import { DemoBadge } from './components/DemoBadge'
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
import { mockCases, mockSessions } from './mock/sessions'
import mockSpectral from './mock/spectral.json'
import { reportSuggestions } from './suggestions'
import { isTerminal } from './pipeline/reducer'
import { isRefusedReport, type ReportBody, type RuleFindings, type SpectralData, type Stage } from './types'

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

  const queryClient = useQueryClient()
  const [deep, setDeep] = useState(false)

  const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.listSessions, retry: false })
  const cases = useQuery({ queryKey: ['cases'], queryFn: api.cases, retry: false, staleTime: Infinity })
  const spectralQuery = useQuery({ queryKey: ['spectral'], queryFn: api.getSpectral, retry: false, staleTime: Infinity })

  // Mock data is only a fallback for "no backend": a network failure or a dev-proxy 5xx (isOffline).
  const [actionOffline, setActionOffline] = useState(false)
  const offline = (sessions.isError && isOffline(sessions.error)) || actionOffline
  const sessionList = useMemo(() => (offline ? mockSessions : (sessions.data ?? [])), [offline, sessions.data])
  const caseList = useMemo(() => (offline ? mockCases : (cases.data ?? [])), [offline, cases.data])
  const spectralDemo = spectralQuery.isError && isOffline(spectralQuery.error)
  const spectral = spectralQuery.data ?? (spectralDemo ? (mockSpectral as unknown as SpectralData) : undefined)

  // The run shown in the main column: one started here or from the chat, else the session's latest run.
  const session = useQuery({
    queryKey: ['session', selectedId],
    queryFn: () => api.getSession(selectedId!),
    enabled: !!selectedId && !offline,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })
  const [runOverride, setRunOverride] = useState<{ sessionId: string; runId: string } | null>(null)
  const latestStored = session.data?.reports?.reduce<{ version: number; run_id: string } | null>(
    (best, r) => (!best || r.version > best.version ? r : best),
    null,
  )
  // A session without a stored report (e.g. refused) still points at its run through its messages.
  const lastMessageRun = session.data?.messages?.reduce<string | null>((last, m) => m.run_id ?? last, null) ?? null
  const override = runOverride?.sessionId === selectedId ? runOverride.runId : null
  const activeRunId = override ?? latestStored?.run_id ?? lastMessageRun

  const liveRun = useRunEvents(activeRunId)
  // Offline only: a synthetic trace that can be replayed.
  const mockRun = useMockRunEvents(MOCK_EVENTS)
  const run = activeRunId ? liveRun : mockRun

  // A run started here is fetched once its stream ends; a stored run right away. 409 ("still running")
  // keeps polling, so a missed terminal event or a browser without EventSource still gets the report.
  const fresh = !!override && override === activeRunId
  const canStream = typeof EventSource !== 'undefined' && liveRun.connection !== 'error'
  const reportQuery = useQuery({
    queryKey: ['report', activeRunId],
    queryFn: () => api.getReport(activeRunId!),
    enabled: !!activeRunId && (!fresh || !canStream || isTerminal(liveRun.state.status)),
    retry: (count, err) => isStillRunning(err) && count < 300,
    retryDelay: 2000,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })
  const runReport = reportQuery.data
  const refused = isRefusedReport(runReport) ? runReport : null
  const live = runReport && !isRefusedReport(runReport) ? runReport : null
  const reportOffline = reportQuery.isError && isOffline(reportQuery.error)

  // Demo mode: no live report and the backend is unreachable.
  const showDemo = !live && !refused && (offline || reportOffline)
  const liveBody = useMemo(() => {
    if (!live) return null
    // `findings` and `scope` feed the charts; the exported report is the AssessmentReport only.
    const { findings: _findings, scope: _scope, ...body } = live
    return body
  }, [live])
  const report: ReportViewData | null = liveBody ?? (showDemo ? (mockReport as ReportBody) : null)
  const rules: RuleFindings | undefined = live ? (live.findings ?? undefined) : showDemo ? (mockFindings as RuleFindings) : undefined
  const citations = useMemo(() => Object.fromEntries((report?.sources ?? []).map((s) => [s.id, s.citation])), [report?.sources])

  const refusal = refused
    ? {
        label: refused.scope?.label ?? 'REFUSED',
        reason: refused.scope?.reason || refused.markdown,
        suggestions: refused.scope?.suggestions,
      }
    : activeRunId && liveRun.state.status === 'refused'
      ? liveRun.state.refusal
      : null
  const failure = !activeRunId
    ? null
    : liveRun.state.status === 'failed'
      ? liveRun.state.error ?? 'Run failed'
      : reportQuery.isError && !reportOffline && !isStillRunning(reportQuery.error)
        ? String(reportQuery.error instanceof Error ? reportQuery.error.message : reportQuery.error)
        : null
  // While a run streams there is no report yet: show the full graph, never a blank spinner.
  const loading = activeRunId
    ? !report && !refusal && !failure
    : run.state.status === 'running' || run.state.status === 'idle'

  const [startingCaseId, setStartingCaseId] = useState<string | null>(null)
  const [caseError, setCaseError] = useState<string | null>(null)

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
    setCaseError(null)
    setSidebarOpen(false)
  }, [])

  /** Create a session and start its run; the main column then streams the run and loads its report. */
  const launch = useCallback(
    async (input: Parameters<typeof api.createSession>[0]) => {
      const created = await api.createSession(input)
      const started = await api.startRun(created.id, deep)
      setRunOverride({ sessionId: created.id, runId: started.run_id })
      setSelectedId(created.id)
      setCitedId(null)
      void queryClient.invalidateQueries({ queryKey: ['sessions'] })
    },
    [deep, queryClient],
  )

  const openCase = useCallback(
    async (caseId: string) => {
      setComposing(false)
      setSidebarOpen(false)
      setCaseError(null)
      setStartingCaseId(caseId)
      try {
        await launch({ case_id: caseId })
      } catch (err) {
        if (isOffline(err)) {
          setActionOffline(true)
          setSelectedId(null)
        } else setCaseError(`Could not start ${caseId}: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setStartingCaseId(null)
      }
    },
    [launch],
  )

  const startAssessment = async (text: string) => {
    setStarting(true)
    setStartError(null)
    try {
      await launch({ text })
      setComposing(false)
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
      ...caseList.map((c) => ({
        id: `case-${c.case_id}`,
        group: 'Run case',
        label: `${c.case_id} · ${c.title}`,
        keywords: 'run case new session',
        icon: Play,
        run: () => void openCase(c.case_id),
      })),
      ...sessionList.map((s) => ({
        id: `open-${s.id}`,
        group: 'Open session',
        label: s.case_id ? `${s.case_id} · ${s.title}` : s.title || 'Untitled enquiry',
        keywords: 'open case session',
        icon: FolderOpen,
        run: () => openSession(s.id),
      })),
      ...(report
        ? [
            { id: 'md', group: 'Export', label: 'Download Markdown', icon: FileText, run: () => void downloadMarkdown(report, activeRunId) },
            { id: 'json', group: 'Export', label: 'Download JSON', icon: Braces, run: () => downloadJson(report) },
            { id: 'print', group: 'Export', label: 'Print / save as PDF', icon: Printer, run: printReport },
            { id: 'email', group: 'Export', label: 'Customer e-mail draft', icon: Mail, run: () => setEmailOpen(true) },
          ]
        : []),
    ],
    [caseList, sessionList, report, activeRunId, newEnquiry, openSession, openCase],
  )

  const showPipeline = !!activeRunId || showDemo
  const emptyMessage = startingCaseId
    ? `Starting ${startingCaseId}…`
    : selectedId
      ? session.isPending
        ? 'Loading session…'
        : session.isError
          ? `Could not load the session: ${session.error instanceof Error ? session.error.message : String(session.error)}`
          : 'This session has no run yet.'
      : 'Pick a case from the sidebar or start a new enquiry.'

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
        deep={deep}
        onToggleDeep={() => setDeep((d) => !d)}
      />
      <SessionSidebar
        cases={caseList}
        sessions={sessionList}
        loading={sessions.isPending}
        notice={offline ? 'Backend offline: showing mock sessions.' : undefined}
        demo={offline}
        selectedId={selectedId}
        startingCaseId={startingCaseId}
        onSelect={openSession}
        onSelectCase={(id) => void openCase(id)}
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
        ) : !showPipeline ? (
          <section aria-label="Assessment" className="mx-auto flex max-w-4xl flex-col gap-3 p-6">
            <p className="flex items-center gap-2 text-sm text-muted" aria-live="polite">
              {(startingCaseId || (selectedId && session.isPending)) && (
                <Loader2 size={14} aria-hidden="true" className="animate-spin text-fiber-cyan" />
              )}
              {emptyMessage}
            </p>
            {caseError && (
              <p role="alert" className="flex items-center gap-2 text-sm" style={{ color: 'var(--status-bad)' }}>
                <CircleAlert size={14} aria-hidden="true" /> {caseError}
              </p>
            )}
          </section>
        ) : (
          <>
            <section aria-label="Pipeline" className="mx-auto flex max-w-4xl flex-col gap-2 px-6 pt-6">
              <div className="flex items-center justify-between gap-2 text-xs text-muted">
                <span aria-live="polite" className="flex items-center gap-2">
                  {showDemo && <DemoBadge />}
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
                  {!loading && report && !refusal && (
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
            ) : failure ? (
              <div className="mx-auto max-w-4xl p-6">
                <p role="alert" className="flex items-center gap-2 text-sm" style={{ color: 'var(--status-bad)' }}>
                  <CircleAlert size={14} aria-hidden="true" /> {failure}
                </p>
              </div>
            ) : (
              !loading &&
              report && (
                <>
                  <ReportView
                    report={report}
                    spectral={spectral}
                    rules={rules}
                    onCite={cite}
                    notice={
                      showDemo || spectralDemo ? (
                        <>
                          <DemoBadge />
                          {showDemo ? 'Mock report (no backend connected)' : 'Spectral chart uses built-in ranges (backend offline)'}
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
              fallback={report?.sources?.find((s) => s.id === citedId)}
              onClose={() => setCitedId(null)}
            />
          ) : undefined
        }
        chat={
          <ChatPanel
            sessionId={selectedId}
            report={report ?? undefined}
            citations={citations}
            onCite={cite}
            value={chatDraft}
            onValueChange={setChatDraft}
            onRunStarted={(runId) => selectedId && setRunOverride({ sessionId: selectedId, runId })}
            onRunCompleted={() => void queryClient.invalidateQueries({ queryKey: ['sessions'] })}
          />
        }
      />
      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
      {report && (
        <EmailDraftModal
          open={emailOpen}
          sessionId={selectedId}
          runId={activeRunId}
          report={report}
          onClose={() => setEmailOpen(false)}
        />
      )}
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
