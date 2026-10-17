import { useId, type ReactNode } from 'react'
import { ArrowRight, CircleCheck, CircleMinus, CirclePlus, RefreshCw, type LucideIcon } from 'lucide-react'
import { ROLE_LABEL, STATUS_LABEL, VERDICT_LABEL, labelOf } from '../labels'
import type { DiffRecommendation, DiffRecommendationChange, Question, ReportDiff, Risk } from '../types'

type ChangeKind = 'added' | 'removed' | 'changed' | 'resolved' | 'new'

/** Every change chip carries an icon and a text label besides its colour. */
const KIND: Record<ChangeKind, { label: string; icon: LucideIcon; color: string }> = {
  added: { label: 'Added', icon: CirclePlus, color: 'var(--status-ok)' },
  removed: { label: 'Removed', icon: CircleMinus, color: 'var(--status-bad)' },
  changed: { label: 'Changed', icon: RefreshCw, color: 'var(--status-warn)' },
  resolved: { label: 'Resolved', icon: CircleCheck, color: 'var(--status-ok)' },
  new: { label: 'New', icon: CirclePlus, color: 'var(--fiber-orange)' },
}

function KindChip({ kind }: { kind: ChangeKind }) {
  const { label, icon: Icon, color } = KIND[kind]
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
      style={{ borderColor: color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
      <Icon size={11} aria-hidden="true" style={{ color }} />
      {label}
    </span>
  )
}

const recName = (r: DiffRecommendation | DiffRecommendationChange) => {
  if (typeof r === 'string') return r
  const methods = r.methods?.join(' + ')
  return [methods, r.technique].filter(Boolean).join(' · ') || r.key || 'Recommendation'
}

const roleOf = (r: DiffRecommendation) => (typeof r === 'string' ? undefined : r.role)

const roleChange = (r: DiffRecommendationChange) => {
  if (typeof r === 'string') return null
  const from = r.role?.from ?? r.from_role ?? r.from
  const to = r.role?.to ?? r.to_role ?? r.to
  return from || to ? { from, to } : null
}

const questionText = (q: string | Question) => (typeof q === 'string' ? q : q.question)
const riskText = (r: string | Risk) => (typeof r === 'string' ? r : r.risk.map((s) => s.text).join(' '))

function FromTo({ from, to }: { from: ReactNode; to: ReactNode }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="text-muted line-through decoration-1">{from}</span>
      <ArrowRight size={12} aria-hidden="true" />
      <span className="sr-only">changed to</span>
      <span className="font-semibold">{to}</span>
    </span>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-1">
      <h4 id={id} className="text-xs font-bold uppercase tracking-wider text-muted">
        {title}
      </h4>
      {children}
    </div>
  )
}

function Row({ kind, children }: { kind: ChangeKind; children: ReactNode }) {
  return (
    <li className="flex flex-wrap items-start gap-2 text-sm">
      <KindChip kind={kind} />
      <span className="min-w-0 flex-1">{children}</span>
    </li>
  )
}

interface DiffViewProps {
  diff: ReportDiff
  from: number
  to: number
}

/** What changed between two report versions after new client information (`GET /sessions/{id}/diff`). */
export function DiffView({ diff, from, to }: DiffViewProps) {
  const headingId = useId()
  const { recommendations: recs, questions, risks } = diff
  const hasRecs = recs.added.length + recs.removed.length + recs.changed.length > 0
  const hasQuestions = questions.resolved.length + questions.new.length > 0
  const hasRisks = risks.added.length + risks.removed.length > 0
  const empty = !diff.status && !diff.verdict && !hasRecs && !hasQuestions && !hasRisks

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3">
      <h3 id={headingId} className="flex items-center gap-2 text-sm font-bold">
        <RefreshCw size={14} aria-hidden="true" className="text-fiber-cyan" />
        Changes from v{from} to v{to}
      </h3>

      {empty && <p className="text-sm text-muted">No changes between the two versions.</p>}

      {diff.status && (
        <Group title="Decision status">
          <p className="text-sm">
            <FromTo from={labelOf(STATUS_LABEL, diff.status.from)} to={labelOf(STATUS_LABEL, diff.status.to)} />
          </p>
        </Group>
      )}

      {diff.verdict && (
        <Group title="Direct answer">
          <p className="text-sm">
            <FromTo from={labelOf(VERDICT_LABEL, diff.verdict.from)} to={labelOf(VERDICT_LABEL, diff.verdict.to)} />
          </p>
        </Group>
      )}

      {hasRecs && (
        <Group title="Recommendations">
          <ul className="flex flex-col gap-1.5">
            {recs.added.map((r, i) => (
              <Row key={`a${i}`} kind="added">
                <span className="font-semibold">{recName(r)}</span>
                {roleOf(r) && <span className="ml-2 text-muted">{labelOf(ROLE_LABEL, roleOf(r))}</span>}
              </Row>
            ))}
            {recs.removed.map((r, i) => (
              <Row key={`r${i}`} kind="removed">
                <span className="font-semibold">{recName(r)}</span>
                {roleOf(r) && <span className="ml-2 text-muted">{labelOf(ROLE_LABEL, roleOf(r))}</span>}
              </Row>
            ))}
            {recs.changed.map((r, i) => {
              const change = roleChange(r)
              return (
                <Row key={`c${i}`} kind="changed">
                  <span className="mr-2 font-semibold">{recName(r)}</span>
                  {change && (
                    <FromTo from={labelOf(ROLE_LABEL, change.from) || '—'} to={labelOf(ROLE_LABEL, change.to) || '—'} />
                  )}
                </Row>
              )
            })}
          </ul>
        </Group>
      )}

      {hasQuestions && (
        <Group title="Questions">
          <ul className="flex flex-col gap-1.5">
            {questions.resolved.map((q, i) => (
              <Row key={`q${i}`} kind="resolved">
                {questionText(q)}
              </Row>
            ))}
            {questions.new.map((q, i) => (
              <Row key={`n${i}`} kind="new">
                {questionText(q)}
              </Row>
            ))}
          </ul>
        </Group>
      )}

      {hasRisks && (
        <Group title="Risks">
          <ul className="flex flex-col gap-1.5">
            {risks.added.map((r, i) => (
              <Row key={`ra${i}`} kind="added">
                {riskText(r)}
              </Row>
            ))}
            {risks.removed.map((r, i) => (
              <Row key={`rr${i}`} kind="removed">
                {riskText(r)}
              </Row>
            ))}
          </ul>
        </Group>
      )}
    </section>
  )
}
