import { useCallback, useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  Ban,
  BookOpen,
  CircleHelp,
  ClipboardCheck,
  FileText,
  Globe,
  Lightbulb,
  User,
  type LucideIcon,
} from 'lucide-react'
import { api } from './api'
import { Header, type Theme } from './components/Header'
import { RightPanel } from './components/RightPanel'
import { SessionSidebar } from './components/SessionSidebar'
import mockReport from './mock/report.json'
import { mockSessions } from './mock/sessions'
import type { ClaimType, DecisionStatus, ReportBody, Segment } from './types'

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

// ---------------------------------------------------------------- minimal report preview (full view: Task 27)

const STATUS: Record<DecisionStatus, { label: string; icon: LucideIcon; color: string }> = {
  PROVISIONAL: { label: 'Provisional', icon: ClipboardCheck, color: 'var(--status-ok)' },
  INSUFFICIENT_INFORMATION: { label: 'Insufficient information', icon: AlertTriangle, color: 'var(--status-warn)' },
  OUTSIDE_SUPPORTED_SCOPE: { label: 'Outside supported scope', icon: Ban, color: 'var(--status-bad)' },
}

const CLAIM: Record<ClaimType, { label: string; icon: LucideIcon; color: string }> = {
  CLIENT: { label: 'Client', icon: User, color: 'var(--afs-prism-500)' },
  AFS: { label: 'AFS', icon: BookOpen, color: 'var(--fiber-cyan)' },
  EXTERNAL: { label: 'External', icon: Globe, color: 'var(--fiber-magenta)' },
  ASSUMPTION: { label: 'Assumption', icon: AlertTriangle, color: 'var(--fiber-orange)' },
  PROPOSAL: { label: 'Proposal', icon: Lightbulb, color: 'var(--text-muted)' },
  UNKNOWN: { label: 'Unknown', icon: CircleHelp, color: 'var(--text-muted)' },
}

function ClaimChip({ type }: { type: ClaimType }) {
  const { label, icon: Icon, color } = CLAIM[type]
  return (
    <span
      className="mr-1.5 inline-flex items-center gap-1 rounded border px-1.5 py-0.5 align-middle text-[11px] font-semibold uppercase tracking-wide"
      style={{ borderColor: color, color }}
    >
      <Icon size={11} aria-hidden="true" />
      {label}
    </span>
  )
}

function Segments({ segments }: { segments: Segment[] }) {
  return (
    <>
      {segments.map((s, i) => (
        <p key={i} className="mb-1 text-sm leading-relaxed">
          <ClaimChip type={s.claim_type} />
          {s.text}
          {s.evidence_ids.length > 0 && (
            <span className="ml-1 font-mono text-xs text-muted">[{s.evidence_ids.join(', ')}]</span>
          )}
        </p>
      ))}
    </>
  )
}

function ReportPreview({ report }: { report: ReportBody }) {
  const status = STATUS[report.decision_status]
  const StatusIcon = status.icon
  return (
    <article className="mx-auto flex max-w-4xl flex-col gap-4 p-6" aria-label="Assessment report">
      <div className="flex items-center gap-2 text-xs text-muted">
        <FileText size={14} aria-hidden="true" /> Mock report (no backend connected)
      </div>
      <div
        className="flex items-center gap-2 rounded-lg border bg-surface px-4 py-3 font-semibold"
        style={{ borderColor: status.color }}
      >
        <StatusIcon size={18} aria-hidden="true" style={{ color: status.color }} />
        <span>Status: {status.label}</span>
      </div>

      <section className="rounded-lg border border-line bg-surface p-4" aria-labelledby="answer-heading">
        <h2 id="answer-heading" className="mb-2 text-sm font-bold">
          Direct answer · <span className="font-mono text-xs">{report.direct_answer.verdict}</span>
        </h2>
        <Segments segments={report.direct_answer.text} />
      </section>

      <section className="rounded-lg border border-line bg-surface p-4" aria-labelledby="recs-heading">
        <h2 id="recs-heading" className="mb-2 text-sm font-bold">
          Recommendations
        </h2>
        <ul className="flex flex-col gap-3">
          {report.recommendations.map((r, i) => (
            <li key={i}>
              <div className="mb-1 text-sm font-semibold">
                {r.methods.join(' + ')} · {r.technique}{' '}
                <span className="font-mono text-xs text-muted">{r.role}</span>
              </div>
              <Segments segments={r.rationale} />
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-lg border border-line bg-surface p-4" aria-labelledby="questions-heading">
        <h2 id="questions-heading" className="mb-2 text-sm font-bold">
          Clarification questions
        </h2>
        <ol className="list-decimal pl-5 text-sm">
          {[...report.clarification_questions]
            .sort((a, b) => a.priority - b.priority)
            .map((q, i) => (
              <li key={i} className="mb-1">
                {q.question} <span className="text-muted">({q.decision_it_changes})</span>
              </li>
            ))}
        </ol>
      </section>
    </article>
  )
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
        <ReportPreview report={mockReport as ReportBody} />
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
