import { useMemo, useState } from 'react'
import { Check, CircleAlert, Copy, Loader2, Mail, RotateCw, Sparkles } from 'lucide-react'
import { reportToMarkdown } from '../../export'
import { BlurIn } from '../../motion'
import type { Assessment } from '../../state/useAssessment'
import { ExportMenu } from '../ExportMenu'
import { RefusalCard } from '../RefusalCard'
import { ReportView } from '../report/ReportView'
import { PipelineSteps, PipelineSummary } from './PipelineSteps'
import { SourceCards } from './SourceCards'
import { citationCounts } from './sources'

export interface AssessmentBlockProps {
  assessment: Assessment
}

/**
 * The assistant's answer to the enquiry: pipeline progress, Sources, Results (the report), action bar,
 * or the refusal / failure states. Phase 2 restyles the report body; the structure stays.
 */
export function AssessmentBlock({ assessment: a }: AssessmentBlockProps) {
  const { report, refusal, failure, loading, run, activeRunId } = a
  const [copied, setCopied] = useState(false)
  const counts = useMemo(() => (report ? citationCounts(report) : {}), [report])

  const copy = async () => {
    if (!report) return
    try {
      await navigator.clipboard.writeText(reportToMarkdown(report))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard unavailable: the Export menu still offers the download
    }
  }

  return (
    <div className="assistant-block" aria-label="Assessment" role="region">
      {loading && (
        <BlurIn delay={200} y={6}>
          <PipelineSteps state={run.state} />
        </BlurIn>
      )}
      {!loading && !refusal && (activeRunId || report) && (
        <PipelineSummary state={run.state} onViewGraph={a.showGraph} />
      )}

      {refusal && <RefusalCard reason={refusal.reason} label={refusal.label} suggestions={refusal.suggestions} onExample={a.fillComposer} />}

      {failure && !refusal && (
        <p role="alert" className="inline-error">
          <CircleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>{failure}</span>
          <button type="button" className="link-btn" onClick={() => void a.rerun(a.deep)}>
            Try again
          </button>
        </p>
      )}

      {report && !refusal && (
        <>
          <SourceCards sources={report.sources ?? []} counts={counts} onOpen={a.cite} onMore={a.openSources} />
          <section aria-labelledby="thread-results-title">
            <BlurIn delay={200} y={6}>
              <h2 id="thread-results-title" className="section-title">
                {loading ? <Loader2 size={20} strokeWidth={1.75} className="spin" aria-hidden="true" /> : <Sparkles size={20} strokeWidth={1.75} aria-hidden="true" />}
                Results
              </h2>
            </BlurIn>
            <BlurIn delay={280} y={8}>
              <ReportView report={report} spectral={a.spectral} rules={a.rules} onCite={a.cite} />
            </BlurIn>
          </section>
          <BlurIn delay={600} y={6} className="action-bar" as="div">
            <button type="button" className="btn btn-sm" onClick={() => void copy()}>
              {copied ? <Check size={16} strokeWidth={1.75} aria-hidden="true" /> : <Copy size={16} strokeWidth={1.75} aria-hidden="true" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            <ExportMenu report={report} runId={activeRunId} onEmailDraft={() => a.setEmailOpen(true)} className="btn btn-sm" align="left" />
            <button type="button" className="btn btn-sm" onClick={() => a.setEmailOpen(true)}>
              <Mail size={16} strokeWidth={1.75} aria-hidden="true" /> E-mail draft
            </button>
            <button type="button" className="btn btn-sm" onClick={() => void a.rerun(true)}>
              <RotateCw size={16} strokeWidth={1.75} aria-hidden="true" /> Re-run (deep)
            </button>
          </BlurIn>
        </>
      )}
    </div>
  )
}
