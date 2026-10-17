import { Check, Circle, CircleAlert, Loader2, Network } from 'lucide-react'
import { STAGE_LABELS, type PipelineState } from '../../pipeline/reducer'
import { formatSeconds, totalSeconds } from '../../pipeline/status'
import { STAGES } from '../../types'

/** While running: the nine stages as a compact vertical list (spinner on the active one). */
export function PipelineSteps({ state }: { state: PipelineState }) {
  return (
    <ol className="steps" aria-label="Pipeline stages" aria-live="polite">
      {STAGES.map((stage) => {
        const st = state.stages[stage]
        const secs = formatSeconds(st.seconds)
        return (
          <li key={stage} data-status={st.status} className="step">
            <span className="step-icon" aria-hidden="true">
              {st.status === 'running' ? (
                <Loader2 size={16} strokeWidth={2} className="spin" style={{ color: 'var(--violet)' }} />
              ) : st.status === 'done' ? (
                <Check size={16} strokeWidth={2.25} style={{ color: 'var(--status-ok)' }} />
              ) : st.status === 'warning' || st.status === 'failed' || st.status === 'refused' ? (
                <CircleAlert size={16} strokeWidth={2} style={{ color: st.status === 'warning' ? 'var(--status-warn)' : 'var(--status-bad)' }} />
              ) : (
                <Circle size={16} strokeWidth={1.75} style={{ color: '#c4c6cf' }} />
              )}
            </span>
            <span className="step-name">{STAGE_LABELS[stage]}</span>
            <span className="sr-only">{st.status}</span>
            {secs && <span className="step-time tabular">{secs}</span>}
          </li>
        )
      })}
    </ol>
  )
}

/** After completion: one line "Pipeline · 9 stages · 71 s · View graph". */
export function PipelineSummary({ state, onViewGraph }: { state: PipelineState; onViewGraph: () => void }) {
  const total = totalSeconds(state)
  return (
    <p className="pipeline-line">
      <Network size={16} strokeWidth={1.75} aria-hidden="true" />
      <span>
        Pipeline · {STAGES.length} stages{total !== null ? ` · ${formatSeconds(total)}` : ''}
      </span>
      <button type="button" className="link-btn" onClick={onViewGraph}>
        View graph
      </button>
    </p>
  )
}
