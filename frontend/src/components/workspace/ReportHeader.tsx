import { useEffect, useState } from 'react'
import { Check, Copy, EllipsisVertical, GitCompare, Loader2, Mail, RotateCw } from 'lucide-react'
import { type ExportOptions, reportToMarkdown } from '../../export'
import { formatSessionDate } from '../../sessions'
import type { Assessment } from '../../state/useAssessment'
import type { TabId } from '../../state/tabs'
import { formatScore, rankedCandidates } from '../../assistant/format'
import type { EnginePreview, ReportViewData } from '../../types'
import { ExportMenu } from '../ExportMenu'
import { VerdictPill } from '../report/DirectAnswer'
import { StatusBanner } from '../report/StatusBanner'
import { STATUS } from '../report/status'
import { Dropdown, type DropdownItem } from '../shell/Dropdown'
import { Skeleton } from '../../motion'
import { Appear } from '../thread/Appear'
import type { ReportModel } from './model'
import { useMediaQuery } from './useMediaQuery'

interface ReportHeaderProps {
  assessment: Assessment
  exportOptions?: ExportOptions
  onToggleConversation?: () => void
  onToggleTechnical?: () => void
  report: ReportViewData
  model: ReportModel
  /** A fresh report: the pills, answer and key facts blur in once. */
  reveal: boolean
}

function Actions({ assessment: a, report, exportOptions, onToggleConversation, onToggleTechnical }: Pick<ReportHeaderProps, 'assessment' | 'report' | 'exportOptions' | 'onToggleConversation' | 'onToggleTechnical'>) {
  const [copied, setCopied] = useState(false)
  // below 760 px the bar has room for the title and one menu: every action moves into it
  const compact = useMediaQuery('(max-width: 759px)', false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(reportToMarkdown(report, exportOptions))
      setCopied(true)
    } catch {
      // clipboard unavailable: the Export menu still offers the download
    }
  }
  const versionItems: DropdownItem[] = [...a.versions].reverse().map((v) => ({
    id: `v${v.version}`,
    label: `Report v${v.version}`,
    checked: v.version === a.currentVersion,
    onSelect: () => a.selectVersion(v.version),
  }))
  const compare: DropdownItem = {
    id: 'compare',
    label: a.previousVersion !== null ? `What changed since v${a.previousVersion}` : 'What changed',
    icon: GitCompare,
    disabled: a.previousVersion === null,
    onSelect: () => a.setCompareOpen(true),
  }
  const version = a.versions.length > 1 && (
    <Dropdown ariaLabel="Switch report version" items={versionItems} align="right" className="btn btn-sm">
      <span>v{a.currentVersion}</span>
    </Dropdown>
  )

  if (compact) {
    return (
      <div className="rh-actions" data-print-hide>
        {version}
        <ExportMenu report={report} runId={a.activeRunId} options={exportOptions} onToggleConversation={onToggleConversation} onToggleTechnical={onToggleTechnical} onEmailDraft={() => a.setEmailOpen(true)} className="btn btn-sm" />
        <Dropdown
          ariaLabel="More actions"
          align="right"
          className="btn btn-sm btn-icon"
          chevron={false}
          items={[
            { id: 'copy', label: copied ? 'Copied' : 'Copy as Markdown', icon: copied ? Check : Copy, onSelect: () => void copy() },
            { id: 'email', label: 'Customer e-mail draft', icon: Mail, separatorBefore: true, onSelect: () => a.setEmailOpen(true) },
            { id: 'rerun', label: 'Re-run (deep)', icon: RotateCw, onSelect: () => void a.rerun(true) },
            { ...compare, separatorBefore: true },
          ]}
        >
          <EllipsisVertical size={16} strokeWidth={1.75} aria-hidden="true" />
        </Dropdown>
      </div>
    )
  }

  return (
    <div className="rh-actions" data-print-hide>
      {version}
      <button type="button" className="btn btn-sm rh-icon" onClick={() => void copy()} aria-live="polite" title="Copy the report as Markdown">
        {copied ? <Check size={16} strokeWidth={1.75} aria-hidden="true" /> : <Copy size={16} strokeWidth={1.75} aria-hidden="true" />}
        <span className="rh-btn-label">{copied ? 'Copied' : 'Copy'}</span>
      </button>
      <ExportMenu report={report} runId={a.activeRunId} options={exportOptions} onToggleConversation={onToggleConversation} onToggleTechnical={onToggleTechnical} onEmailDraft={() => a.setEmailOpen(true)} className="btn btn-sm" labelClassName="rh-export-label" />
      <button type="button" className="btn btn-sm rh-icon" onClick={() => a.setEmailOpen(true)} aria-label="E-mail draft" title="Customer e-mail draft">
        <Mail size={16} strokeWidth={1.75} aria-hidden="true" />
        <span className="rh-btn-label">E-mail draft</span>
      </button>
      <button type="button" className="btn btn-sm rh-icon" onClick={() => void a.rerun(true)} aria-label="Re-run (deep)" title="Run the assessment again in deep mode">
        <RotateCw size={16} strokeWidth={1.75} aria-hidden="true" />
        <span className="rh-btn-label">Re-run (deep)</span>
      </button>
      <Dropdown
        ariaLabel="More actions"
        align="right"
        className="btn btn-sm btn-icon"
        chevron={false}
        items={[compare]}
      >
        <EllipsisVertical size={16} strokeWidth={1.75} aria-hidden="true" />
      </Dropdown>
    </div>
  )
}

interface Fact {
  id: string
  label: string
  value: string
  sub: string
  tab: TabId
  tone?: 'bad'
  /** The report does not have what this stat reads yet. */
  pending?: boolean
}

/** Four numbers a scientist wants before reading: the lead method, the decision status, what is open, whether the checks hold. */
function keyFacts(report: ReportViewData, model: ReportModel, engine: EnginePreview | null): Fact[] {
  const { pending } = model
  const lead = model.primary
  // before a writer has named the recommendations, the engine's best open candidate stands in
  const top = engine ? rankedCandidates(engine.candidates).find((c) => !c.blocked) : undefined
  const status = STATUS[report.decision_status]
  const failed = model.compliance.filter(([, ok]) => !ok)
  return [
    {
      id: 'method',
      label: 'Primary method',
      value: lead ? lead.methods.join(' + ') : pending.recs && top ? top.method : 'None yet',
      sub: lead
        ? [lead.technique, lead.evidence_strength && `Evidence: ${lead.evidence_strength}`].filter(Boolean).join(' · ')
        : pending.recs && top
          ? `${top.technique ? `${top.technique} · ` : ''}engine score ${formatScore(top.score)}`
          : 'No method is recommended yet',
      tab: 'methods',
      pending: pending.recs && !top,
    },
    { id: 'status', label: 'Decision status', value: status.label, sub: status.detail.split('. ')[0].replace(/\.$/, ''), tab: 'plan', pending: pending.decision },
    {
      id: 'questions',
      label: 'Open questions',
      value: String(model.questions.length),
      sub: pending.requirements ? 'Ranked by decision impact' : `${model.unknowns.length} key ${model.unknowns.length === 1 ? 'unknown' : 'unknowns'}`,
      tab: 'questions',
      pending: pending.questions,
    },
    {
      id: 'checks',
      label: 'Checks',
      value: model.compliance.length ? `${model.passed}/${model.compliance.length} passed` : 'Not stored',
      sub: failed.length ? `${failed.length} failed` : model.compliance.length ? 'All compliance checks' : 'No compliance data',
      tab: 'checks',
      tone: failed.length ? 'bad' : undefined,
      pending: pending.compliance,
    },
  ]
}

/**
 * The report's title bar (sticky: title, version and date, actions) and, below it, what scrolls away: the status and
 * verdict pills, the one-sentence direct answer and the key-facts strip. Fragment: both parts are children of the pane's scroll
 * content so the bar can stick.
 */
export function ReportHeader({ assessment: a, report, model, reveal, exportOptions, onToggleConversation, onToggleTechnical }: ReportHeaderProps) {
  const { pending } = model
  const title = report.title || a.title || 'Assessment report'
  const when = report.created_at ? formatSessionDate(report.created_at) : ''
  return (
    <>
      <div className="rh-bar">
        <div className="rp-w rh-bar-in">
          <div className="rh-id">
            <h2 className="rh-title" title={title}>
              {title}
            </h2>
            <p className="rh-meta tabular">{[a.currentVersion !== null && `Report v${a.currentVersion}`, when].filter(Boolean).join(' · ')}</p>
          </div>
          {a.reportPartial ? (
            <p className="rh-writing" role="status">
              {!a.previewOnly && <Loader2 size={15} strokeWidth={2} className="spin" aria-hidden="true" />}
              {a.previewOnly ? 'Engine preview' : 'Writing the report…'}
            </p>
          ) : (
            <Actions assessment={a} report={report} exportOptions={exportOptions} onToggleConversation={onToggleConversation} onToggleTechnical={onToggleTechnical} />
          )}
        </div>
      </div>
      <Appear animate={reveal} delay={0} duration={400} y={6} className="rp-w rh-body">
        {report.version_info && report.version_info.version > 1 && report.version_info.trigger && (
          <p className="rh-changed">
            <GitCompare size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>
              <strong>v{report.version_info.version}</strong> after “{report.version_info.trigger}”. {report.version_info.summary}
            </span>
            {a.previousVersion !== null && (
              <button type="button" className="link-btn" onClick={() => a.setCompareOpen(true)} data-print-hide>
                What changed
              </button>
            )}
          </p>
        )}
        <div className="rh-pills">
          {pending.decision ? <Skeleton height={24} width={150} radius={999} /> : <StatusBanner status={report.decision_status} />}
          {pending.answer ? <Skeleton height={24} width={96} radius={999} /> : <VerdictPill verdict={report.direct_answer.verdict} />}
        </div>
        <ul className="rh-facts" aria-label="Key facts">
          {keyFacts(report, model, a.enginePreview).filter((f) => f.id !== 'status').map((f) => (
            <li key={f.id}>
              <button type="button" className="kf" data-tone={f.tone} onClick={() => a.setTab(f.tab)} aria-busy={f.pending || undefined}>
                <span className="kf-label">{f.label}</span>
                {f.pending ? (
                  <>
                    <span role="status" aria-label={`Loading ${f.label.toLowerCase()}`}>
                      <Skeleton height={16} width="56%" radius={5} />
                    </span>
                    <Skeleton height={12} width="82%" radius={5} />
                  </>
                ) : (
                  <>
                    <span className="kf-value tabular">{f.value}</span>
                    <span className="kf-sub clamp-2">{f.sub}</span>
                  </>
                )}
              </button>
            </li>
          ))}
        </ul>
      </Appear>
    </>
  )
}
