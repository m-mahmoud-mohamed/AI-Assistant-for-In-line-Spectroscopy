import { CircleAlert } from 'lucide-react'
import { BlurIn } from '../../motion'
import type { Assessment } from '../../state/useAssessment'
import { RefusalCard } from '../RefusalCard'
import { PipelineSteps, PipelineSummary } from './PipelineSteps'
import { ReportBlock } from './ReportBlock'

export interface AssessmentBlockProps {
  assessment: Assessment
}

/**
 * The assistant's answer to the enquiry: pipeline progress, Sources, Results (the report), action bar,
 * or the refusal / failure states.
 */
export function AssessmentBlock({ assessment: a }: AssessmentBlockProps) {
  const { report, refusal, failure, loading, run, activeRunId } = a

  return (
    <div className="assistant-block" aria-label="Assessment" role="region">
      {loading && (
        <BlurIn delay={200} y={6}>
          <PipelineSteps state={run.state} />
        </BlurIn>
      )}
      {!loading && !refusal && (activeRunId || report) && <PipelineSummary state={run.state} onViewGraph={a.showGraph} />}

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
        <ReportBlock
          key={activeRunId ?? 'report'}
          assessment={a}
          report={report}
          rules={a.rules}
          runId={activeRunId}
          running={run.state.status === 'running'}
          fresh={a.freshRun}
        />
      )}
    </div>
  )
}
