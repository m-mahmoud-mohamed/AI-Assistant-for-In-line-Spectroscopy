// All session / run / report / chat state and actions of the app. App.tsx is a thin shell around this hook;
// Home, Workspace, TopBar and Rail only receive the pieces they render (docs: see `Assessment`).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, isOffline, isStillRunning } from '../api'
import type { ComposerHandle } from '../components/composer/Composer'

import { useRunEvents, type RunEventsResult } from '../hooks/useRunEvents'
import { isTerminal } from '../pipeline/reducer'
import { questionDraft, suggestedTasks, type SuggestedTask, type TaskAction } from '../suggestions'
import { completeReport, type RawReport } from '../reportData'
import { readHashTab, writeHashTab, type TabId } from './tabs'
import {
  isRefusedReport,
  type ChatMessage,
  type ChatResponse,
  type ReportVersion,
  type ReportViewData,
  type RuleFindings,
  type Session,
  type SessionDetail,
  type SpectralData,
  type Stage,
} from '../types'

export type View = 'home' | 'thread' | 'history'

/** Below 1180 px the workspace shows one pane at a time: the conversation or the report. */
export type Pane = 'conversation' | 'report'

export type AnswerResponse = Extract<ChatResponse, { kind: 'answer' }>

/** One entry of the follow-up conversation shown inline in the thread (after the assessment block). */
export type Turn =
  | { id: string; kind: 'history'; message: ChatMessage }
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'answer'; answer: AnswerResponse; offline?: boolean }
  | { id: string; kind: 'run'; runId: string; expected: number }
  | { id: string; kind: 'refused'; reason: string; suggestions: string[] }
  | { id: string; kind: 'error'; text: string }

export interface Refusal {
  label: string
  reason: string
  suggestions?: string[]
}

let turnSeq = 0
const nextTurnId = () => `turn-${++turnSeq}`

const OFFLINE_ANSWER: AnswerResponse = {
  kind: 'answer',
  text: "PRISM's API is not reachable, so this message was not sent. Start it with `make api`.",
  cited_ids: [],
  tool_calls: [],
  proposed_facts: [],
}

/** First line of an enquiry as a provisional session title. */
export const provisionalTitle = (text: string): string => {
  const line = text.trim().split(/\n/)[0] ?? ''
  return line.length > 64 ? `${line.slice(0, 61).trimEnd()}…` : line
}

export function useAssessment() {
  const queryClient = useQueryClient()

  // ------------------------------------------------------------ navigation and UI state
  const [view, setView] = useState<View>('home')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /** The enquiry being created (shown as the bubble before the session exists). */
  const [pending, setPending] = useState<{ text: string } | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  const [deep, setDeep] = useState(false)
  const [web, setWeb] = useState(false)
  const [draft, setDraft] = useState('')
  const [citedId, setCitedId] = useState<string | null>(null)
  const [pane, setPane] = useState<Pane>('conversation')
  // The active report tab is remembered per session (and in the URL hash, `#tab=methods`).
  const [tabBySession, setTabBySession] = useState<Record<string, TabId>>({})
  const [startTab, setStartTab] = useState<TabId | null>(() => readHashTab())
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [emailOpen, setEmailOpen] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  const [graphOpen, setGraphOpen] = useState(false)
  const [selectedStage, setSelectedStage] = useState<Stage | null>(null)
  const [actionOffline, setActionOffline] = useState(false)
  const composerHandle = useRef<ComposerHandle | null>(null)
  /** Pass as the Composer's `ref` so the hook can focus it and open its file picker. */
  const registerComposer = useCallback((handle: ComposerHandle | null) => {
    composerHandle.current = handle
  }, [])
  const attachFile = useCallback(() => composerHandle.current?.attach(), [])

  // ------------------------------------------------------------ server state
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: api.listSessions,
    retry: false,
    // While the API is down keep probing so the notice clears once `make api` is running.
    refetchInterval: (q) => (q.state.status === 'error' && isOffline(q.state.error) ? 8000 : false),
  })
  const spectralQuery = useQuery({ queryKey: ['spectral'], queryFn: api.getSpectral, retry: false, staleTime: Infinity })
  const spectral: SpectralData | undefined = spectralQuery.data

  const offline = (sessions.isError && isOffline(sessions.error)) || actionOffline
  const sessionList: Session[] = useMemo(() => (offline ? [] : (sessions.data ?? [])), [offline, sessions.data])
  const apiStatus: 'checking' | 'online' | 'offline' = offline ? 'offline' : sessions.isSuccess ? 'online' : 'checking'

  const session = useQuery({
    queryKey: ['session', selectedId],
    queryFn: () => api.getSession(selectedId!),
    enabled: !!selectedId && !offline,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })
  const sessionData: SessionDetail | undefined = session.data

  // ------------------------------------------------------------ which run is shown
  const [runOverride, setRunOverride] = useState<{ sessionId: string; runId: string } | null>(null)
  const [versionPick, setVersionPick] = useState<{ sessionId: string; version: number } | null>(null)

  const versions: ReportVersion[] = useMemo(
    () => [...(sessionData?.reports ?? [])].sort((a, b) => a.version - b.version),
    [sessionData?.reports],
  )
  const latestStored = versions.length ? versions[versions.length - 1] : null
  // A session without a stored report (e.g. refused) still points at its run through its messages.
  const lastMessageRun = sessionData?.messages?.reduce<string | null>((last, m) => m.run_id ?? last, null) ?? null
  const override = runOverride?.sessionId === selectedId ? runOverride.runId : null
  const pickedRun = versionPick?.sessionId === selectedId ? versions.find((v) => v.version === versionPick.version)?.run_id : undefined
  const activeRunId = override ?? pickedRun ?? latestStored?.run_id ?? lastMessageRun

  const liveRun: RunEventsResult = useRunEvents(activeRunId)

  // A run started here is fetched once its stream ends; a stored run right away. 409 ("still running")
  // keeps polling, so a missed terminal event or a browser without EventSource still gets the report.
  const fresh = !!override && override === activeRunId
  const canStream = typeof EventSource !== 'undefined' && liveRun.connection !== 'error'
  const reportQuery = useQuery({
    queryKey: ['report', activeRunId],
    queryFn: () => api.getReport(activeRunId!),
    enabled: !!activeRunId && !offline && (!fresh || !canStream || isTerminal(liveRun.state.status)),
    retry: (count, err) => isStillRunning(err) && count < 300,
    retryDelay: 2000,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })
  const runReport = reportQuery.data
  const refused = isRefusedReport(runReport) ? runReport : null
  const live = runReport && !isRefusedReport(runReport) ? runReport : null

  // `findings` and `scope` feed the charts; the exported report is the AssessmentReport only. The report may lack
  // sections (still being written): `reportRaw` is it as delivered (the workspace shows skeletons for what is absent),
  // `report` fills the absent ones empty so that exports, suggestions and the e-mail draft can rely on its shape.
  const reportRaw: RawReport | null = useMemo(() => {
    if (!live) return null
    const { findings: _findings, scope: _scope, ...body } = live
    return body
  }, [live])
  const report: ReportViewData | null = useMemo(() => (reportRaw ? completeReport(reportRaw) : null), [reportRaw])
  const rules: RuleFindings | undefined = live?.findings ?? undefined
  const citations: Record<string, string> = useMemo(
    () => Object.fromEntries((report?.sources ?? []).map((s) => [s.id, s.citation])),
    [report?.sources],
  )

  const streamRefusal = activeRunId && liveRun.state.status === 'refused' ? liveRun.state.refusal : null
  const refusal: Refusal | null = useMemo(
    () =>
      refused
        ? { label: refused.scope?.label ?? 'REFUSED', reason: refused.scope?.reason || refused.markdown, suggestions: refused.scope?.suggestions }
        : streamRefusal,
    [refused, streamRefusal],
  )
  const reportOffline = reportQuery.isError && isOffline(reportQuery.error)
  const failure: string | null = !activeRunId
    ? null
    : liveRun.state.status === 'failed'
      ? (liveRun.state.error ?? 'Run failed')
      : reportQuery.isError && !reportOffline && !isStillRunning(reportQuery.error)
        ? String(reportQuery.error instanceof Error ? reportQuery.error.message : reportQuery.error)
        : null
  /** The enquiry is being created or its run is in flight: the pipeline is shown instead of the report. */
  const starting = !!pending && !selectedId
  const loading = starting || (activeRunId ? !report && !refusal && !failure : false)

  const currentVersion: number | null = !activeRunId
    ? null
    : (versions.find((v) => v.run_id === activeRunId)?.version ?? (versions.length ? versions[versions.length - 1].version + 1 : 1))
  const previousVersion: number | null =
    currentVersion === null
      ? null
      : versions.reduce<number | null>((best, v) => (v.version < currentVersion && (best === null || v.version > best) ? v.version : best), null)

  // When a run completes, the stored session gains a report version: refresh the detail and the list.
  const status = liveRun.state.status
  useEffect(() => {
    if (status === 'completed' && selectedId) {
      void queryClient.invalidateQueries({ queryKey: ['session', selectedId] })
      void queryClient.invalidateQueries({ queryKey: ['sessions'] })
    }
  }, [status, activeRunId, selectedId, queryClient])

  // ------------------------------------------------------------ derived thread content
  const firstUser = sessionData?.messages?.find((m) => m.role === 'user')
  const enquiryText: string | null = firstUser?.text ?? pending?.text ?? null
  const title: string = sessionData?.title || (pending ? provisionalTitle(pending.text) : '')

  // ------------------------------------------------------------ follow-up conversation
  const [turnsBySession, setTurnsBySession] = useState<Record<string, Turn[]>>({})
  const [sending, setSending] = useState(false)
  const pushTurns = useCallback(
    (sid: string, ...add: Turn[]) => setTurnsBySession((all) => ({ ...all, [sid]: [...(all[sid] ?? []), ...add] })),
    [],
  )

  const turns: Turn[] = useMemo(() => {
    const history: Turn[] = (sessionData?.messages ?? [])
      .filter((m) => m !== firstUser)
      // the refusal of the shown run is rendered by the assessment block, not as a chat message
      .filter((m) => !(m.role === 'assistant' && m.kind === 'refused' && m.run_id === activeRunId && refusal))
      .map((m) => ({ id: `h-${m.id}`, kind: 'history', message: m }))
    return [...history, ...(selectedId ? (turnsBySession[selectedId] ?? []) : [])]
  }, [sessionData?.messages, firstUser, activeRunId, refusal, selectedId, turnsBySession])

  // ------------------------------------------------------------ actions
  const focusComposer = useCallback(() => {
    setTimeout(() => composerHandle.current?.focus(), 0)
  }, [])

  const newEnquiry = useCallback(
    (text?: string) => {
      setView('home')
      setSelectedId(null)
      setPending(null)
      setStartError(null)
      setCitedId(null)
      setPane('conversation')
      setGraphOpen(false)
      setSelectedStage(null)
      setDraft(text ?? '')
      focusComposer()
    },
    [focusComposer],
  )

  const openSession = useCallback((id: string) => {
    setView('thread')
    setSelectedId(id)
    setPending(null)
    setCitedId(null)
    setGraphOpen(false)
    setVersionPick(null)
  }, [])

  const openHistory = useCallback(() => setView('history'), [])
  const openThread = useCallback(() => setView(selectedId || pending ? 'thread' : 'home'), [selectedId, pending])

  /** Create a session and start its run; the thread streams the run and then loads its report. */
  const startEnquiry = useCallback(
    async (text: string) => {
      setPending({ text })
      setSelectedId(null)
      setView('thread')
      setStartError(null)
      setCitedId(null)
      setPane('conversation')
      setVersionPick(null)
      setDraft('')
      try {
        const created = await api.createSession({ text })
        const started = await api.startRun(created.id, deep, web)
        setRunOverride({ sessionId: created.id, runId: started.run_id })
        setSelectedId(created.id)
        void queryClient.invalidateQueries({ queryKey: ['sessions'] })
      } catch (err) {
        const down = isOffline(err)
        if (down) setActionOffline(true)
        setView('home')
        setPending(null)
        setSelectedId(null)
        setDraft(text)
        setStartError(down ? "PRISM's API is not reachable — start it with `make api`." : `Could not start the assessment: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [deep, web, queryClient],
  )

  const sendFollowUp = useCallback(
    async (text: string) => {
      if (!selectedId || sending) return
      const sid = selectedId
      pushTurns(sid, { id: nextTurnId(), kind: 'user', text })
      setDraft('')
      setSending(true)
      try {
        const res = await api.postMessage(sid, text)
        if (res.kind === 'run') {
          // Runs started here that are not stored yet come before this one.
          const stored = new Set(versions.map((v) => v.run_id))
          const pendingRuns = (turnsBySession[sid] ?? []).filter((t) => t.kind === 'run' && !stored.has(t.runId)).length
          const expected = (versions.length ? versions[versions.length - 1].version : 0) + pendingRuns + 1
          // The new run is a "Report vN" notice in the conversation; the report pane stays on the version it shows until
          // the user opens the new one (otherwise the newest stored version would replace it the moment it completes).
          if (currentVersion !== null) setVersionPick((pick) => (pick?.sessionId === sid ? pick : { sessionId: sid, version: currentVersion }))
          pushTurns(sid, { id: nextTurnId(), kind: 'run', runId: res.run_id, expected })
        } else if (res.kind === 'refused') {
          pushTurns(sid, { id: nextTurnId(), kind: 'refused', reason: res.reason, suggestions: res.suggestions ?? [] })
        } else {
          pushTurns(sid, { id: nextTurnId(), kind: 'answer', answer: res })
        }
      } catch (err) {
        if (isOffline(err)) {
          setActionOffline(true)
          pushTurns(sid, { id: nextTurnId(), kind: 'answer', answer: OFFLINE_ANSWER, offline: true })
        } else pushTurns(sid, { id: nextTurnId(), kind: 'error', text: err instanceof Error ? err.message : 'Message failed.' })
      } finally {
        setSending(false)
      }
    },
    [selectedId, sending, versions, currentVersion, turnsBySession, pushTurns],
  )

  /** Send the composer text: an enquiry on the home view, a follow-up in a thread. */
  const submit = useCallback(() => {
    const text = draft.trim()
    if (!text || offline || sending || starting) return
    if (view === 'home') void startEnquiry(text)
    else void sendFollowUp(text)
  }, [draft, offline, sending, starting, view, startEnquiry, sendFollowUp])

  /** Start a new run of the open session (no new facts), e.g. "Re-run (deep)". */
  const rerun = useCallback(
    async (deepMode: boolean) => {
      if (!selectedId) return
      const sid = selectedId
      try {
        const started = await api.startRun(sid, deepMode, web)
        setVersionPick(null)
        setRunOverride({ sessionId: sid, runId: started.run_id })
      } catch (err) {
        if (isOffline(err)) setActionOffline(true)
        else pushTurns(sid, { id: nextTurnId(), kind: 'error', text: err instanceof Error ? err.message : 'Could not start the run.' })
      }
    },
    [selectedId, web, pushTurns],
  )

  const fillComposer = useCallback(
    (text: string) => {
      setDraft(text)
      setPane('conversation')
      focusComposer()
    },
    [focusComposer],
  )

  const fillQuestion = useCallback((question: string) => fillComposer(questionDraft(question)), [fillComposer])

  const runTask = useCallback(
    (action: TaskAction) => {
      if (action.kind === 'email') setEmailOpen(true)
      else if (action.kind === 'rerun-deep') void rerun(true)
      else fillComposer(action.text)
    },
    [rerun, fillComposer],
  )

  const tab: TabId = (selectedId ? tabBySession[selectedId] : undefined) ?? startTab ?? 'overview'
  const setTab = useCallback(
    (next: TabId) => {
      setStartTab(null)
      setTabBySession((all) => ({ ...all, [selectedId ?? '_']: next }))
    },
    [selectedId],
  )

  // The URL hash follows the active tab while a session is open and is cleared elsewhere.
  useEffect(() => {
    if (view === 'thread' && selectedId) writeHashTab(tab)
    else if (view !== 'thread') writeHashTab(null)
  }, [view, selectedId, tab])
  useEffect(() => {
    if (!selectedId) return
    const onHash = () => {
      const fromHash = readHashTab()
      if (fromHash) setTabBySession((all) => (all[selectedId] === fromHash ? all : { ...all, [selectedId]: fromHash }))
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [selectedId])

  // A citation chip anywhere opens the Evidence tab focused on that source.
  const cite = useCallback(
    (cardId: string) => {
      setCitedId(cardId)
      setTab('evidence')
      setPane('report')
    },
    [setTab],
  )
  const closeCitation = useCallback(() => setCitedId(null), [])
  const openSources = useCallback(() => {
    setCitedId(null)
    setTab('evidence')
    setPane('report')
    if (selectedId || pending) setView('thread')
  }, [selectedId, pending, setTab])

  // The report (or a refusal / failure) of a run arriving shows the report pane when only one pane fits.
  const outcomeRun = report || refusal || failure ? (activeRunId ?? '') : null
  const [shownOutcome, setShownOutcome] = useState<string | null>(null)
  if (outcomeRun !== null && outcomeRun !== shownOutcome) {
    setShownOutcome(outcomeRun)
    setPane('report')
  }

  const selectVersion = useCallback(
    (version: number) => {
      if (!selectedId) return
      setRunOverride(null)
      setVersionPick({ sessionId: selectedId, version })
      setCitedId(null)
    },
    [selectedId],
  )

  const showGraph = useCallback(() => {
    setGraphOpen(true)
    setView('thread')
  }, [])

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

  const onRunCompleted = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['sessions'] })
  }, [queryClient])

  const tasks: SuggestedTask[] = useMemo(() => suggestedTasks(report ?? undefined), [report])

  return {
    // navigation
    view,
    selectedId,
    openSession,
    openHistory,
    openThread,
    newEnquiry,
    // connection
    offline,
    apiStatus,
    // sessions
    sessionList,
    sessionsLoading: sessions.isPending,
    session: sessionData,
    sessionLoading: !!selectedId && session.isPending,
    sessionError: session.isError ? (session.error instanceof Error ? session.error.message : String(session.error)) : null,
    title,
    enquiryText,
    // composer
    registerComposer,
    attachFile,
    draft,
    setDraft,
    submit,
    deep,
    setDeep,
    web,
    setWeb,
    startError,
    sending,
    fillComposer,
    fillQuestion,
    // the run and its report
    activeRunId,
    /** The shown run was started in this session (its report streams in); false for stored sessions and versions. */
    freshRun: fresh,
    run: liveRun,
    report,
    reportRaw,
    rules,
    spectral,
    citations,
    refusal,
    failure,
    loading,
    starting,
    versions,
    currentVersion,
    previousVersion,
    selectVersion,
    rerun,
    // follow-ups
    turns,
    sendFollowUp,
    onRunCompleted,
    // report workspace: tabs, panes, evidence and overlays
    tab,
    setTab,
    pane,
    setPane,
    citedId,
    cite,
    closeCitation,
    openSources,
    tasks,
    runTask,
    graphOpen,
    setGraphOpen,
    showGraph,
    selectedStage,
    setSelectedStage,
    paletteOpen,
    setPaletteOpen,
    emailOpen,
    setEmailOpen,
    compareOpen,
    setCompareOpen,
  }
}

/** The value `useAssessment()` returns; Workspace, TopBar, Rail and Home take it (or pieces of it) as props. */
export type Assessment = ReturnType<typeof useAssessment>
