import { useId, type ReactNode } from 'react'
import { ArrowRight, CircleCheck, CircleMinus, CirclePlus, RefreshCw, type LucideIcon } from 'lucide-react'
import { ROLE_LABEL, STATUS_LABEL, VERDICT_LABEL, labelOf } from '../labels'
import './panel/panel.css'
import type { DiffRecommendation, DiffRecommendationChange, Question, ReportDiff, Risk } from '../types'

type ChangeKind = 'added' | 'removed' | 'changed' | 'resolved' | 'new'

/** Every change chip carries an icon and a text label besides its colour; rows are tinted to match. */
const KIND: Record<ChangeKind, { label: string; icon: LucideIcon; tone: 'add' | 'del' | 'chg' | 'new' }> = {
  added: { label: 'Added', icon: CirclePlus, tone: 'add' },
  removed: { label: 'Removed', icon: CircleMinus, tone: 'del' },
  changed: { label: 'Changed', icon: RefreshCw, tone: 'chg' },
  resolved: { label: 'Resolved', icon: CircleCheck, tone: 'add' },
  new: { label: 'New', icon: CirclePlus, tone: 'new' },
}

function KindChip({ kind }: { kind: ChangeKind }) {
  const { label, icon: Icon, tone } = KIND[kind]
  return (
    <span className="df-chip" data-tone={tone}>
      <Icon size={12} strokeWidth={2} aria-hidden="true" />
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
    <span className="df-fromto">
      <span className="df-old">{from}</span>
      <ArrowRight size={13} strokeWidth={1.75} aria-hidden="true" />
      <span className="sr-only">changed to</span>
      <span className="df-new">{to}</span>
    </span>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return (
    <div role="group" aria-labelledby={id} className="df-group">
      <h4 id={id}>{title}</h4>
      {children}
    </div>
  )
}

function Row({ kind, children }: { kind: ChangeKind; children: ReactNode }) {
  return (
    <li className="df-row" data-tone={KIND[kind].tone}>
      <KindChip kind={kind} />
      <span className="df-text" data-struck={kind === 'removed' || undefined}>
        {children}
      </span>
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
    <section aria-labelledby={headingId} className="df">
      <h3 id={headingId} className="df-title">
        <RefreshCw size={15} strokeWidth={1.75} aria-hidden="true" />
        Changes from v{from} to v{to}
      </h3>

      {empty && <p className="df-empty">No changes between the two versions.</p>}

      {diff.status && (
        <Group title="Decision status">
          <p className="df-line">
            <FromTo from={labelOf(STATUS_LABEL, diff.status.from)} to={labelOf(STATUS_LABEL, diff.status.to)} />
          </p>
        </Group>
      )}

      {diff.verdict && (
        <Group title="Direct answer">
          <p className="df-line">
            <FromTo from={labelOf(VERDICT_LABEL, diff.verdict.from)} to={labelOf(VERDICT_LABEL, diff.verdict.to)} />
          </p>
        </Group>
      )}

      {hasRecs && (
        <Group title="Recommendations">
          <ul className="df-rows">
            {recs.added.map((r, i) => (
              <Row key={`a${i}`} kind="added">
                <span className="df-name">{recName(r)}</span>
                {roleOf(r) && <span className="df-muted">{labelOf(ROLE_LABEL, roleOf(r))}</span>}
              </Row>
            ))}
            {recs.removed.map((r, i) => (
              <Row key={`r${i}`} kind="removed">
                <span className="df-name">{recName(r)}</span>
                {roleOf(r) && <span className="df-muted">{labelOf(ROLE_LABEL, roleOf(r))}</span>}
              </Row>
            ))}
            {recs.changed.map((r, i) => {
              const change = roleChange(r)
              return (
                <Row key={`c${i}`} kind="changed">
                  <span className="df-name">{recName(r)}</span>
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
          <ul className="df-rows">
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
          <ul className="df-rows">
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
