import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { CircleCheck, CircleHelp, CircleX, Quote } from 'lucide-react'
import type { AssessmentReport, ReportBody } from '../../types'
import { ClaimChip, ClaimText } from './ClaimText'
import { DirectAnswer } from './DirectAnswer'
import { MethodCard, MethodsTab } from './MethodsTab'
import { PlanTimeline } from './PlanTimeline'
import { PremiseChecks } from './PremiseChecks'
import { QuestionsList } from './QuestionsList'
import { SourcesTab } from './SourcesTab'
import { StatusBanner } from './StatusBanner'

/** A full AssessmentReport, or just the LLM body (the mock) with whatever metadata is available. */
export type ReportViewData = ReportBody & Partial<Omit<AssessmentReport, keyof ReportBody>>

const TABS = [
  'Overview',
  'Requirements',
  'Questions',
  'Methods',
  'Concept',
  'Spectral',
  'Risks',
  'Plan',
  'Sources',
  'Trace',
] as const
type Tab = (typeof TABS)[number]

interface ReportViewProps {
  report: ReportViewData
  /** Optional external handler (e.g. the evidence panel); by default a citation opens the Sources tab. */
  onCite?: (cardId: string) => void
  /** Short note above the report, e.g. "Mock report (no backend connected)". */
  notice?: ReactNode
}

const humanise = (slot: string) => slot.replaceAll('_', ' ')

function Card({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="rounded-lg border border-line bg-surface p-4">
      <h2 id={id} className="mb-2 text-sm font-bold">
        {title}
      </h2>
      {children}
    </section>
  )
}

const Empty = ({ children }: { children: ReactNode }) => <p className="text-sm text-muted">{children}</p>

export function ReportView({ report, onCite, notice }: ReportViewProps) {
  const [tab, setTab] = useState<Tab>('Overview')
  const [selectedSource, setSelectedSource] = useState<string | null>(null)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const baseId = useId()

  const sources = useMemo(() => report.sources ?? [], [report.sources])
  const citations = useMemo(() => Object.fromEntries(sources.map((s) => [s.id, s.citation])), [sources])
  const streamName = (id: string | null) => (id && report.streams?.find((s) => s.id === id)?.name) || id

  const cite = (cardId: string) => {
    if (onCite) {
      onCite(cardId)
      return
    }
    setSelectedSource(cardId)
    setTab('Sources')
  }
  const claim = { onCite: cite, citations }

  const onTabKey = (e: KeyboardEvent, index: number) => {
    const next =
      e.key === 'ArrowRight' ? (index + 1) % TABS.length
      : e.key === 'ArrowLeft' ? (index - 1 + TABS.length) % TABS.length
      : e.key === 'Home' ? 0
      : e.key === 'End' ? TABS.length - 1
      : null
    if (next === null) return
    e.preventDefault()
    setTab(TABS[next])
    tabRefs.current[next]?.focus()
  }

  const featured = report.recommendations.filter((r) => r.role === 'PRIMARY' || r.role === 'COMPARISON')
  const overviewRecs = featured.length > 0 ? featured : report.recommendations

  const panels: Record<Tab, () => ReactNode> = {
    Overview: () => (
      <div className="flex flex-col gap-4">
        <DirectAnswer answer={report.direct_answer} {...claim} />
        <PremiseChecks checks={report.premise_checks} {...claim} />
        <Card title="Top questions">
          <QuestionsList questions={report.clarification_questions} limit={3} />
        </Card>
        <Card title={featured.length > 0 ? 'Primary and comparison methods' : 'Methods'}>
          <div className="flex flex-col gap-3">
            {overviewRecs.map((r, i) => (
              <MethodCard key={i} rec={r} compact {...claim} />
            ))}
          </div>
        </Card>
      </div>
    ),

    Requirements: () => (
      <div className="flex flex-col gap-4">
        <Card title="Stated facts">
          {report.requirements.stated_facts.length === 0 ? (
            <Empty>No facts extracted yet.</Empty>
          ) : (
            <ul className="flex flex-col gap-3">
              {report.requirements.stated_facts.map((f, i) => (
                <li key={i}>
                  <div className="text-sm">
                    <span className="font-semibold">{humanise(f.slot)}:</span> {f.value}
                    {f.stream_id && <span className="ml-2 font-mono text-xs text-muted">{streamName(f.stream_id)}</span>}
                  </div>
                  <blockquote className="mt-1 flex items-start gap-1 border-l-2 border-prism-500 pl-3 text-sm italic text-muted">
                    <ClaimChip type="CLIENT" />
                    <Quote size={12} aria-hidden="true" className="mt-1 shrink-0" />
                    <span>{f.quote}</span>
                  </blockquote>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Key unknowns">
          {report.requirements.key_unknowns.length === 0 ? (
            <Empty>No open unknowns.</Empty>
          ) : (
            <ul className="flex flex-col gap-2">
              {report.requirements.key_unknowns.map((u, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2 text-sm">
                  <span
                    className="inline-flex items-center gap-1 rounded-full border border-dashed border-line px-2 py-0.5 text-xs text-muted"
                    title={u.why_it_matters}
                  >
                    <CircleHelp size={12} aria-hidden="true" />
                    {humanise(u.slot)}: unknown
                  </span>
                  {u.stream_id && <span className="font-mono text-xs text-muted">{streamName(u.stream_id)}</span>}
                  <span className="text-muted">{u.why_it_matters}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Interpretation notes">
          {!report.interpretations?.length ? (
            <Empty>No terms needed interpretation.</Empty>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {report.interpretations.map((t, i) => (
                <li key={i}>
                  “{t.term}” read as <span className="font-semibold">{t.canonical ?? 'not resolved'}</span>{' '}
                  <span className="font-mono text-xs text-muted">
                    ({t.kind}, {t.how})
                  </span>
                  {t.ambiguous && (
                    <span className="ml-2 inline-flex items-center gap-1 rounded border border-fiber-orange px-1.5 text-xs">
                      <CircleHelp size={11} aria-hidden="true" className="text-fiber-orange" />
                      Ambiguous
                    </span>
                  )}
                  {t.alternatives.length > 0 && (
                    <span className="ml-2 text-muted">alternatives: {t.alternatives.join(', ')}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    ),

    Questions: () => (
      <Card title="Clarification questions">
        <QuestionsList questions={report.clarification_questions} />
      </Card>
    ),

    Methods: () => <MethodsTab recommendations={report.recommendations} {...claim} />,

    Concept: () => (
      <div className="flex flex-col gap-3">
        {report.measurement_concept.map((m, i) => (
          <Card key={i} title={`Stream: ${streamName(m.stream_id)}`}>
            <dl className="mb-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted">Probe geometry</dt>
              <dd>{m.probe_geometry}</dd>
              <dt className="text-muted">Location</dt>
              <dd>{m.location}</dd>
              <dt className="text-muted">Fiber link</dt>
              <dd>{m.fiber_link}</dd>
            </dl>
            <ClaimText segments={m.notes} {...claim} />
          </Card>
        ))}
      </div>
    ),

    Spectral: () =>
      report.spectral_ranges.length === 0 ? (
        <Empty>No spectral ranges in this report.</Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {report.spectral_ranges.map((s, i) => (
            <Card key={i} title={s.method}>
              <dl className="mb-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted">Nominal range</dt>
                <dd className="font-mono">{s.nominal_range}</dd>
                {s.excitation_nm && (
                  <>
                    <dt className="text-muted">Excitation</dt>
                    <dd className="font-mono">{s.excitation_nm} nm</dd>
                  </>
                )}
                <dt className="text-muted">Fiber family needed</dt>
                <dd>{s.fiber_family_needed}</dd>
              </dl>
              <ClaimText segments={s.caveat} {...claim} />
            </Card>
          ))}
        </div>
      ),

    Risks: () => (
      <div className="flex flex-col gap-4">
        <Card title="Risks">
          {report.risks.length === 0 ? (
            <Empty>No risks listed.</Empty>
          ) : (
            <ul className="flex flex-col gap-3">
              {report.risks.map((r, i) => (
                <li key={i} className="border-l-2 border-fiber-orange pl-3">
                  <ClaimText segments={r.risk} {...claim} />
                  <p className="text-sm">
                    <span className="text-muted">Effect:</span> {r.effect}
                  </p>
                  <p className="text-sm">
                    <span className="text-muted">Mitigation:</span> {r.mitigation}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Assumptions">
          {report.assumptions.length === 0 ? (
            <Empty>No assumptions listed.</Empty>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {report.assumptions.map((a, i) => (
                <li key={i}>
                  <ClaimChip type="ASSUMPTION" />
                  {a.assumption} <span className="text-muted">· confirm with {a.to_confirm_with}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    ),

    Plan: () => <PlanTimeline plan={report.feasibility_plan} {...claim} />,

    Sources: () => <SourcesTab sources={sources} selectedId={selectedSource} />,

    Trace: () => (
      <div className="flex flex-col gap-4">
        <Card title="Decision basis">
          <ClaimText segments={report.decision_basis} {...claim} empty="No decision basis recorded." />
        </Card>
        <Card title="Run">
          {report.run_id ? (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              {(
                [
                  ['Case', report.case_id],
                  ['Run', report.run_id],
                  ['Created', report.created_at],
                  ['Profile', report.profile],
                  ['KB version', report.kb_version],
                  ['Input SHA-256', report.input_sha256],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted">{k}</dt>
                  <dd className="break-all font-mono text-xs leading-5">{v ?? '—'}</dd>
                </div>
              ))}
              {Object.entries(report.model_ids ?? {}).map(([role, model]) => (
                <div key={`m-${role}`} className="contents">
                  <dt className="text-muted">Model · {role}</dt>
                  <dd className="break-all font-mono text-xs leading-5">{model}</dd>
                </div>
              ))}
              {Object.entries(report.prompt_hashes ?? {}).map(([name, hash]) => (
                <div key={`p-${name}`} className="contents">
                  <dt className="text-muted">Prompt · {name}</dt>
                  <dd className="break-all font-mono text-xs leading-5">{hash}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <Empty>Run metadata appears once the API returns the full report.</Empty>
          )}
        </Card>
        {report.compliance && Object.keys(report.compliance).length > 0 && (
          <Card title="Compliance checks">
            <ul className="flex flex-col gap-1 text-sm">
              {Object.entries(report.compliance).map(([check, ok]) => (
                <li key={check} className="flex items-center gap-2">
                  {ok ? (
                    <CircleCheck size={14} aria-hidden="true" style={{ color: 'var(--status-ok)' }} />
                  ) : (
                    <CircleX size={14} aria-hidden="true" style={{ color: 'var(--status-bad)' }} />
                  )}
                  <span className="font-semibold">{ok ? 'Pass' : 'Fail'}</span>
                  <span className="font-mono text-xs">{check}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    ),
  }

  const tabId = (t: Tab) => `${baseId}-tab-${t}`
  const panelId = `${baseId}-panel`

  return (
    <article className="mx-auto flex max-w-4xl flex-col gap-4 p-6" aria-label="Assessment report">
      {notice && <div className="flex items-center gap-2 text-xs text-muted">{notice}</div>}
      {report.title && <h1 className="text-lg font-bold">{report.title}</h1>}
      <StatusBanner status={report.decision_status} />

      <div role="tablist" aria-label="Report sections" className="flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((t, i) => {
          const active = t === tab
          return (
            <button
              key={t}
              ref={(el) => {
                tabRefs.current[i] = el
              }}
              id={tabId(t)}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={panelId}
              tabIndex={active ? 0 : -1}
              onClick={() => setTab(t)}
              onKeyDown={(e) => onTabKey(e, i)}
              className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-semibold ${
                active ? 'border-prism-500 text-fg' : 'border-transparent text-muted hover:text-fg'
              }`}
            >
              {t}
            </button>
          )
        })}
      </div>

      <div role="tabpanel" id={panelId} aria-labelledby={tabId(tab)} tabIndex={0}>
        {panels[tab]()}
      </div>
    </article>
  )
}
