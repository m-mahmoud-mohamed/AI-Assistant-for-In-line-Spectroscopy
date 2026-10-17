import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Check, Copy, EllipsisVertical, GitCompare, Loader2, Mail, Printer, RotateCw, Sparkles, Braces } from 'lucide-react'
import { downloadJson, printReport, reportToMarkdown } from '../../export'
import type { PipelineState } from '../../pipeline/reducer'
import type { Assessment } from '../../state/useAssessment'
import type { RuleFindings } from '../../types'
import { ExportMenu } from '../ExportMenu'
import { ReportView, type ReportViewData } from '../report/ReportView'
import { Dropdown } from '../shell/Dropdown'
import { Appear } from './Appear'
import { useFollow } from './follow'
import { SourceCards } from './SourceCards'
import { citationCounts } from './sources'

/** Runs whose reveal already played: reopening the thread view never replays a reveal. */
const revealed = new Set<string>()

/** Delay (ms) at which the Results text starts, after the Sources heading and cards. */
const sourcesLead = (cards: number) => 120 + (Math.min(cards, 3) + 1) * 60 + 160

export interface ReportBlockProps {
  assessment: Assessment
  report: ReportViewData
  rules?: RuleFindings
  runId: string | null
  /** The run's pipeline state (not needed for a stored report). */
  state?: PipelineState
  /** The run is still in flight: the Results sparkle spins. */
  running?: boolean
  /** This run was started in this session: its report streams in word by word. Stored reports render at once. */
  fresh?: boolean
  /** Extra content between the Sources row and Results (e.g. "What changed" for a re-run). */
  beforeResults?: ReactNode
}

/**
 * Sources row, Results (the flowing report) and the action bar of one run. On a fresh run the Sources
 * heading and cards blur in, the report reveals word by word and the action bar fades in last.
 */
export function ReportBlock({ assessment: a, report, rules, runId, running = false, fresh = false, beforeResults }: ReportBlockProps) {
  // Decided once, when the report first appears: a fresh run that has not revealed yet.
  const [reveal] = useState(() => fresh && !!runId && !revealed.has(runId))
  const [done, setDone] = useState(!reveal)
  useEffect(() => {
    if (reveal && runId) revealed.add(runId)
  }, [reveal, runId])

  const follow = useFollow()
  const counts = useMemo(() => citationCounts(report), [report])
  const sources = report.sources ?? []
  const lead = sourcesLead(sources.length)

  return (
    <>
      <SourceCards sources={sources} counts={counts} onOpen={a.cite} onMore={a.openSources} animate={reveal} />
      {beforeResults}
      <section aria-labelledby={`results-title-${runId ?? 'x'}`}>
        <Appear animate={reveal} delay={lead - 120} y={6}>
          <h2 id={`results-title-${runId ?? 'x'}`} className="section-title">
            {running || !done ? (
              <Loader2 size={20} strokeWidth={1.75} className="spin" aria-hidden="true" />
            ) : (
              <Sparkles size={20} strokeWidth={1.75} aria-hidden="true" />
            )}
            Results
          </h2>
        </Appear>
        <ReportView
          report={report}
          rules={rules}
          spectral={a.spectral}
          onCite={a.cite}
          reveal={reveal}
          revealDelay={lead}
          onRevealSection={follow}
          onRevealDone={() => setDone(true)}
        />
      </section>
      <ActionBar assessment={a} report={report} runId={runId} visible={done} />
    </>
  )
}

function ActionBar({ assessment: a, report, runId, visible }: { assessment: Assessment; report: ReportViewData; runId: string | null; visible: boolean }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(reportToMarkdown(report))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard unavailable: the Export menu still offers the download
    }
  }
  return (
    <div className="action-bar action-bar-in" data-visible={visible ? 'true' : 'false'} data-print-hide>
      <button type="button" className="btn btn-sm" onClick={() => void copy()} aria-live="polite">
        {copied ? <Check size={16} strokeWidth={1.75} aria-hidden="true" /> : <Copy size={16} strokeWidth={1.75} aria-hidden="true" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
      <ExportMenu report={report} runId={runId} onEmailDraft={() => a.setEmailOpen(true)} className="btn btn-sm" align="left" />
      <button type="button" className="btn btn-sm" onClick={() => a.setEmailOpen(true)}>
        <Mail size={16} strokeWidth={1.75} aria-hidden="true" /> E-mail draft
      </button>
      <button type="button" className="btn btn-sm" onClick={() => void a.rerun(true)}>
        <RotateCw size={16} strokeWidth={1.75} aria-hidden="true" /> Re-run (deep)
      </button>
      <div className="action-more">
        <Dropdown
          ariaLabel="More actions"
          align="right"
          className="btn btn-sm btn-icon"
          chevron={false}
          items={[
            { id: 'json', label: 'Download JSON', icon: Braces, onSelect: () => downloadJson(report) },
            { id: 'print', label: 'Print / PDF', icon: Printer, onSelect: printReport },
            {
              id: 'compare',
              label: 'Compare with previous version',
              icon: GitCompare,
              disabled: a.previousVersion === null,
              onSelect: () => a.setCompareOpen(true),
            },
          ]}
        >
          <EllipsisVertical size={16} strokeWidth={1.75} aria-hidden="true" />
        </Dropdown>
      </div>
    </div>
  )
}
