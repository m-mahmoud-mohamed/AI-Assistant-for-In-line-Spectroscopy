// All session / run / report / chat state and actions of the app. App.tsx is a thin shell around this hook;
// Home, Workspace, TopBar and Rail only receive the pieces they render (docs: see `Assessment`).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, isOffline, isStillRunning } from '../api'
import { readRoute, storage, useSessionDraft, writeRoute, type ShellView } from './navigation'
import type { ComposerHandle } from '../components/composer/Composer'

import { useRunEvents, type RunEventsResult } from '../hooks/useRunEvents'
import { isTerminal } from '../pipeline/reducer'
import { questionDraft, suggestedTasks, type SuggestedTask, type TaskAction } from '../suggestions'
import { completeReport, previewFindings, provisionalReport, type RawReport } from '../reportData'
import { readHashTab, writeHashTab, type TabId } from './tabs'
import {
  isRefusedReport,
  type ChatMessage,
  type ChatResponse,
  type EnginePreview,
  type ReportVersion,
  type ReportViewData,
  type RuleFindings,
  type Session,
  type SessionDetail,
  type SpectralData,
  type Suggestion,
  type TurnInput,
} from '../types'

export type View = ShellView

/** Below 1180 px the workspace shows one pane at a time: the conversation or the report. */
export type Pane = 'conversation' | 'report'

export type AnswerResponse = Extract<ChatResponse, { kind: 'answer' }>

/** One entry of the follow-up conversation shown inline in the thread (after the assessment block). */
export type Turn =
  | { id: string; kind: 'history'; message: ChatMessage }
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'answer'; answer: AnswerResponse; offline?: boolean }
  | { id: string; kind: 'run'; runId: string; expected: number }
  /** An assistant turn (plan, tool activity, questions, message, report run), built from its own event stream. */
  | { id: string; kind: 'assistant'; turnId: string }
  | { id: string; kind: 'refused'; reason: string; suggestions: string[] }
  | { id: string; kind: 'error'; text: string }

export interface Refusal {
  label: string
  reason: string
  suggestions?: string[]
}

const NO_MESSAGES: ReadonlySet<string> = new Set()

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
  const [view, setView] = useState<View>(() => readRoute().view)
  const [selectedId, setSelectedId] = useState<string | null>(() => readRoute().sessionId)
  const navigationEpoch = useRef(0)
  const submission = useRef(false)
  /** The enquiry being created (shown as the bubble before the session exists). */
  const [pending, setPending] = useState<{ text: string } | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  const [deep, setDeep] = useState(false)
  const [web, setWeb] = useState(false)
  const [draft, setDraft] = useSessionDraft(selectedId)
  const [citedId, setCitedId] = useState<string | null>(null)
  const [pane, setPane] = useState<Pane>('conversation')
  // The active report tab is remembered per session (and in the URL hash, `#tab=methods`).
  const [tabBySession, setTabBySession] = useState<Record<string, TabId>>(() => {
    try { return JSON.parse(storage.get('prism:tabs') ?? '{}') } catch { return {} }
  })
  const [startTab, setStartTab] = useState<TabId | null>(() => readHashTab())
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [emailOpen, setEmailOpen] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
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
  const sessionList: Session[] = useMemo(() => sessions.data ?? [], [sessions.data])
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
  const [runOverride, setRunOverride] = useState<{ sessionId: string; runId: string; turnId?: string } | null>(null)
  const [versionPick, setVersionPick] = useState<{ sessionId: string; version: number } | null>(null)
  // The assistant turn that feeds the report pane (its verdict preview, then the report run it starts).
  const [flow, setFlow] = useState<{ sessionId: string; turnId: string } | null>(null)
  const [turnVerdicts, setTurnVerdicts] = useState<Record<string, EnginePreview>>({})
  const [runningTurns, setRunningTurns] = useState<Record<string, boolean>>({})

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
  // The engine's result arrives seconds into a run, before any writer: it fills the report's header, status, candidates,
  // questions and spectral windows at once, and the rest shows skeletons. It comes from the run stream (`engine_ready`),
  // or, before a run exists, from the assistant turn's `verdict` (the clarify gate). Stored runs load their report whole.
  const flowActive = !!flow && flow.sessionId === selectedId
  const turnFeedsPane = flowActive && (!activeRunId || (!!runOverride && runOverride.turnId === flow.turnId))
  const enginePreview: EnginePreview | null =
    live || refusal || failure ? null : ((fresh ? liveRun.state.engine : null) ?? (turnFeedsPane ? (turnVerdicts[flow.turnId] ?? null) : null))

  // Sections verified so far: the report endpoint may serve them while the run is still going (409 until it does).
  const sectionsReady = fresh ? liveRun.state.sectionsReady.length : 0
  const partialQuery = useQuery({
    queryKey: ['report-partial', activeRunId, sectionsReady],
    queryFn: () => api.getReport(activeRunId!),
    enabled: !!activeRunId && !offline && sectionsReady > 0 && !live && !refusal && !failure,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  })
  const partial = useMemo(() => {
    const data = partialQuery.data
    if (!data || isRefusedReport(data)) return null
    const { findings, scope: _scope, ...body } = data
    return { body: body as RawReport, findings: findings ?? null }
  }, [partialQuery.data])

  // `findings` and `scope` feed the charts; the exported report is the AssessmentReport only. The report may lack
  // sections (still being written): `reportRaw` is it as delivered (the workspace shows skeletons for what is absent),
  // `report` fills the absent ones empty so that exports, suggestions and the e-mail draft can rely on its shape.
  const reportRaw: RawReport | null = useMemo(() => {
    if (live) {
      const { findings: _findings, scope: _scope, ...body } = live
      const version = versions.find((v) => v.run_id === activeRunId)?.version ?? (versions.length + 1)
      return { ...body,
        original_enquiry: body.original_enquiry ?? sessionData?.messages.find((m) => m.kind === 'enquiry')?.text ?? '',
        version_info: body.version_info ?? { session_id: selectedId ?? '', version, trigger: '', changed_sections: [], summary: version === 1 ? 'Initial assessment.' : 'Earlier report; change summary not stored.', follow_up_findings: [] },
      }
    }
    return enginePreview ? { ...provisionalReport(enginePreview), ...partial?.body } : null
  }, [live, enginePreview, partial, versions, activeRunId, sessionData, selectedId])
  /** The report pane shows what the run has so far, not a finished report: no export, copy or e-mail yet. */
  const reportPartial = !live && !!reportRaw
  /** ...and no run exists yet: only the engine's preview from the assistant's clarify step. */
  const previewOnly = reportPartial && !activeRunId
  const report: ReportViewData | null = useMemo(() => (live && reportRaw ? completeReport(reportRaw) : null), [live, reportRaw])
  const rules: RuleFindings | undefined = useMemo(
    () => live?.findings ?? (enginePreview ? (partial?.findings ?? previewFindings(enginePreview)) : undefined),
    [live, enginePreview, partial],
  )
  const citations: Record<string, string> = useMemo(
    () => Object.fromEntries((report?.sources ?? []).map((s) => [s.id, s.citation])),
    [report?.sources],
  )

  /** The enquiry is being created or its run is in flight: the pipeline is shown instead of the report. */
  const starting = !!pending && !selectedId
  const loading = starting || (activeRunId ? !report && !refusal && !failure : false)
  /** An assistant turn is running (the composer's Send becomes Stop). */
  const turnRunning = flowActive && !!runningTurns[flow.turnId]
  /** A turn is working on the enquiry and no run exists yet: the report pane has nothing but its skeleton (until the verdict). */
  const assisting = turnRunning && !activeRunId
  /** The run shown was started by an assistant turn: that turn's card shows its progress, not the conversation's step list. */
  const turnOwnsRun = !!runOverride && runOverride.sessionId === selectedId && !!runOverride.turnId && runOverride.runId === activeRunId
  /** Remount key of the report workspace: stable from the turn's first preview through its finished report. */
  const reportKey = turnFeedsPane && flow ? `turn:${flow.turnId}` : (activeRunId ?? 'report')

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

  // Messages the stored session held before any assistant turn ran here. Once turns run, the messages they add are stored
  // too; they are shown by the turns themselves, so a refetch of the session must not show them a second time.
  const [createdHere, setCreatedHere] = useState<ReadonlySet<string>>(new Set())
  const [baseline, setBaseline] = useState<Record<string, ReadonlySet<string>>>({})
  if (selectedId && sessionData && !baseline[selectedId]) {
    setBaseline((b) => ({ ...b, [selectedId]: new Set(sessionData.messages.map((m) => m.id)) }))
  }

  const turns: Turn[] = useMemo(() => {
    const local = selectedId ? (turnsBySession[selectedId] ?? []) : []
    const known = selectedId ? (createdHere.has(selectedId) ? NO_MESSAGES : baseline[selectedId]) : undefined
    const stored = local.some((t) => t.kind === 'assistant') && known ? (sessionData?.messages ?? []).filter((m) => known.has(m.id)) : (sessionData?.messages ?? [])
    const history: Turn[] = stored
      .filter((m) => m !== firstUser)
      // the refusal of the shown run is rendered by the assessment block, not as a chat message
      .filter((m) => !(m.role === 'assistant' && m.kind === 'refused' && m.run_id === activeRunId && refusal))
      .map((m) => ({ id: `h-${m.id}`, kind: 'history', message: m }))
    return [...history, ...local]
  }, [sessionData?.messages, firstUser, activeRunId, refusal, selectedId, turnsBySession, baseline, createdHere])

  // ------------------------------------------------------------ actions
  const focusComposer = useCallback(() => {
    setTimeout(() => composerHandle.current?.focus(), 0)
  }, [])

  const newEnquiry = useCallback(
    (text?: string) => {
      navigationEpoch.current += 1
      writeRoute('home', null)
      setView('home')
      setSelectedId(null)
      setPending(null)
      setStartError(null)
      setCitedId(null)
      setPane('conversation')
      if (text !== undefined) storage.set('prism:draft:new', text)
      if (!selectedId) setDraft(text ?? storage.get('prism:draft:new') ?? '')
      focusComposer()
    },
    [focusComposer, selectedId, setDraft],
  )

  const openSession = useCallback((id: string) => {
    navigationEpoch.current += 1
    writeRoute('thread', id)
    setStartTab(readHashTab())
    setView('thread')
    setSelectedId(id)
    setPending(null)
    setCitedId(null)
    setVersionPick(null)
  }, [])

  const navigateView = useCallback((next: View) => {
    navigationEpoch.current += 1
    writeRoute(next, null)
    setView(next)
    setPending(null)
  }, [])
  const openHistory = useCallback(() => navigateView('history'), [navigateView])
  useEffect(() => {
    const pop = () => {
      navigationEpoch.current += 1
      const route = readRoute()
      setView(route.view)
      setSelectedId(route.sessionId)
      setPending(null)
      setVersionPick(null)
      setStartTab(readHashTab())
      if (route.sessionId && readHashTab()) setTabBySession((all) => ({ ...all, [route.sessionId!]: readHashTab()! }))
    }
    window.addEventListener('popstate', pop)
    return () => window.removeEventListener('popstate', pop)
  }, [])
  const openThread = useCallback(() => setView(selectedId || pending ? 'thread' : 'home'), [selectedId, pending])

  // ---- assistant turns (CONTRACTS C4). A backend without the turn API answers 404: everything falls back to runs and chat.
  const turnSupport = useRef<'unknown' | 'yes' | 'no'>('unknown')
  const turnSession = useRef(new Map<string, string>())
  const attachedRuns = useRef(new Set<string>())
  const turnStops = useRef(new Map<string, () => Promise<void>>())
  const runningRef = useRef<Record<string, boolean>>({})

  /** Start an assistant turn. null when the backend has no turn API (404 / 405 before any turn worked): the caller falls back. */
  const startTurnFor = useCallback(async (sid: string, input: TurnInput): Promise<string | null> => {
    if (turnSupport.current === 'no') return null
    try {
      const res = await api.startTurn(sid, input)
      turnSupport.current = 'yes'
      return res.turn_id
    } catch (err) {
      if (turnSupport.current !== 'yes' && err instanceof ApiError && (err.status === 404 || err.status === 405)) {
        turnSupport.current = 'no'
        return null
      }
      throw err
    }
  }, [])

  const openTurn = useCallback(
    (sid: string, turnId: string) => {
      turnSession.current.set(turnId, sid)
      setFlow({ sessionId: sid, turnId })
      runningRef.current[turnId] = true
      setRunningTurns((all) => ({ ...all, [turnId]: true }))
      pushTurns(sid, { id: nextTurnId(), kind: 'assistant', turnId })
    },
    [pushTurns],
  )

  /** Create a session and start its assessment: an assistant turn (plan, questions, report) or, without the turn API, a plain run. */
  const startEnquiry = useCallback(
    async (text: string) => {
      const epoch = navigationEpoch.current
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
        // The Deep and Web switches choose the official batch run; the assistant turn offers them as approvals instead.
        const turnId = deep || web ? null : await startTurnFor(created.id, { text })
        if (turnId) {
          setCreatedHere((all) => new Set(all).add(created.id))
          openTurn(created.id, turnId)
        } else {
          const started = await api.startRun(created.id, deep, web)
          setRunOverride({ sessionId: created.id, runId: started.run_id })
        }
        if (epoch !== navigationEpoch.current) return
        writeRoute('thread', created.id)
        setSelectedId(created.id)
        void queryClient.invalidateQueries({ queryKey: ['sessions'] })
      } catch (err) {
        if (epoch !== navigationEpoch.current) return
        const down = isOffline(err)
        if (down) setActionOffline(true)
        setView('home')
        setPending(null)
        setSelectedId(null)
        setDraft(text)
        setStartError(down ? "PRISM's API is not reachable — start it with `make api`." : `Could not start the assessment: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [deep, web, queryClient, startTurnFor, openTurn, setDraft],
  )

  const sendFollowUp = useCallback(
    async (text: string) => {
      if (!selectedId || sending) return
      const sid = selectedId
      pushTurns(sid, { id: nextTurnId(), kind: 'user', text })
      setDraft('')
      setSending(true)
      try {
        const turnId = await startTurnFor(sid, { text })
        if (turnId) {
          openTurn(sid, turnId)
          return
        }
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
    [selectedId, sending, versions, currentVersion, turnsBySession, pushTurns, startTurnFor, openTurn, setDraft],
  )

  /** A clicked next step: it goes to the assistant as `{action, payload}` and shows as the scientist's message. */
  const runSuggestion = useCallback(
    async (suggestion: Suggestion) => {
      if (!selectedId || sending || turnRunning) return
      const sid = selectedId
      const said = suggestion.action === 'ask' && typeof suggestion.payload === 'string' && suggestion.payload.trim() ? suggestion.payload : suggestion.label
      pushTurns(sid, { id: nextTurnId(), kind: 'user', text: said })
      setSending(true)
      try {
        const turnId = await startTurnFor(sid, { action: suggestion.action, payload: suggestion.payload })
        if (turnId) openTurn(sid, turnId)
        else pushTurns(sid, { id: nextTurnId(), kind: 'error', text: 'The assistant cannot run that step here.' })
      } catch (err) {
        if (isOffline(err)) {
          setActionOffline(true)
          pushTurns(sid, { id: nextTurnId(), kind: 'answer', answer: OFFLINE_ANSWER, offline: true })
        } else pushTurns(sid, { id: nextTurnId(), kind: 'error', text: err instanceof Error ? err.message : 'That step failed.' })
      } finally {
        setSending(false)
      }
    },
    [selectedId, sending, turnRunning, pushTurns, startTurnFor, openTurn],
  )

  /** Stop the running turn (the composer's Stop button). */
  const stopTurn = useCallback(() => {
    const id = flow?.turnId
    if (!id) return
    const stop = turnStops.current.get(id)
    if (stop) void stop()
    else void api.stopTurn(id).catch(() => undefined)
  }, [flow])

  // What a turn's card reports to the rest of the app.
  const onTurnVerdict = useCallback(
    (turnId: string, verdict: EnginePreview) => setTurnVerdicts((all) => (all[turnId] === verdict ? all : { ...all, [turnId]: verdict })),
    [],
  )
  /** The turn started a report run: the report pane attaches to it (once per run, so a replay never takes the pane back). */
  const onTurnReport = useCallback((turnId: string, runId: string) => {
    const key = `${turnId}:${runId}`
    const sid = turnSession.current.get(turnId)
    if (!sid || attachedRuns.current.has(key)) return
    attachedRuns.current.add(key)
    setVersionPick(null)
    setCitedId(null)
    setRunOverride({ sessionId: sid, runId, turnId })
  }, [])
  const onTurnRunning = useCallback(
    (turnId: string, running: boolean) => {
      const was = runningRef.current[turnId] ?? false
      runningRef.current[turnId] = running
      setRunningTurns((all) => (all[turnId] === running ? all : { ...all, [turnId]: running }))
      if (was && !running) void queryClient.invalidateQueries({ queryKey: ['sessions'] })
    },
    [queryClient],
  )
  const registerTurnStop = useCallback((turnId: string, stop: (() => Promise<void>) | null) => {
    if (stop) turnStops.current.set(turnId, stop)
    else turnStops.current.delete(turnId)
  }, [])

  /** Show a run of this session in the report pane (the run a turn started, opened again later). */
  const openRun = useCallback(
    (runId: string) => {
      if (!selectedId) return
      setVersionPick(null)
      setRunOverride({ sessionId: selectedId, runId })
    },
    [selectedId],
  )

  /** Send the composer text: an enquiry on the home view, a follow-up in a thread. */
  const submit = useCallback(() => {
    const text = draft.trim()
    if (!text || offline || sending || starting || turnRunning || submission.current) return
    submission.current = true
    const request = view === 'home' ? startEnquiry(text) : sendFollowUp(text)
    void request.finally(() => { submission.current = false })
  }, [draft, offline, sending, starting, turnRunning, view, startEnquiry, sendFollowUp])

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
    [focusComposer, setDraft],
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

  useEffect(() => storage.set('prism:tabs', JSON.stringify(tabBySession)), [tabBySession])
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
  const openSources = useCallback(() => navigateView('sources'), [navigateView])
  const openSettings = useCallback(() => navigateView('settings'), [navigateView])

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

  // ⌘K / Ctrl+K toggles the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        newEnquiry()
      } else if (e.key === '/' && !(e.target instanceof HTMLElement && (e.target.closest('input, textarea, select, [contenteditable], [role=dialog]')))) {
        e.preventDefault()
        setPane('conversation')
        focusComposer()
      } else if (e.key === 'Escape') setPaletteOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newEnquiry, focusComposer])

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
    /** The report pane shows the engine's result and the sections verified so far, not a finished report. */
    reportPartial,
    previewOnly,
    /** The engine's verdict, candidates and questions before any writer ran (run stream or turn). */
    enginePreview,
    reportKey,
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
    // follow-ups and the assistant
    turns,
    sendFollowUp,
    turnRunning,
    /** The assistant has taken part in this thread: its own next steps replace the generic task chips. */
    hasAssistantTurn: turns.some((t) => t.kind === 'assistant'),
    assisting,
    turnOwnsRun,
    stopTurn,
    runSuggestion,
    openRun,
    onTurnVerdict,
    onTurnReport,
    onTurnRunning,
    registerTurnStop,
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
    openSettings,
    retryConnection: () => { setActionOffline(false); void sessions.refetch(); void session.refetch() },
    tasks,
    runTask,
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
