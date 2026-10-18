import { useId, useState } from 'react'
import { Check, ChevronDown, CircleAlert, Loader2, Minus } from 'lucide-react'
import { flatSteps, type ProgressStep } from './progressSteps'
import './progress.css'

/** A single disclosure for real plan, tool and run events. Finishing always closes the details. */
export function ProgressBlock({ steps, status, completedLabel }: { steps: ProgressStep[]; status: string; completedLabel?: string }) {
  const [expanded, setExpanded] = useState(false)
  const [lastStatus, setLastStatus] = useState(status)
  const id = useId()
  if (lastStatus !== status) {
    setLastStatus(status)
    if (status !== 'running' && status !== 'idle') setExpanded(false)
  }
  const working = status === 'running' || status === 'idle'
  const current = flatSteps(steps).filter((s) => s.status === 'running' || s.status === 'active').sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0]
  const label = working ? current?.label ?? 'Working…' : status === 'failed' ? 'Failed' : status === 'stopped' || status === 'refused' ? 'Stopped' : completedLabel ?? 'Analysis completed'
  return <div className="progress-block" data-status={status}>
    <button className="progress-toggle" type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>
      {working ? <Loader2 size={15} className="progress-indicator" aria-hidden="true" /> : status === 'failed' ? <CircleAlert size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
      <span aria-live="polite">{label}{!working && !completedLabel && ` · ${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`}</span>
      <ChevronDown size={14} aria-hidden="true" className="progress-chevron" />
    </button>
    <div className="progress-reveal" data-open={expanded} aria-hidden={!expanded} inert={!expanded} id={id}>
      <div><StepList steps={steps} label="Analysis steps" />{steps.length === 0 && <p className="rs-muted">Waiting for progress events…</p>}</div>
    </div>
  </div>
}

function StepList({ steps, label }: { steps: ProgressStep[]; label?: string }) {
  return <ol className={label ? 'progress-steps' : 'progress-steps progress-substeps'} aria-label={label}>
    {steps.map((step) => <li key={step.id} data-status={step.status}>
      <span aria-hidden="true">{step.status === 'running' || step.status === 'active' ? <Loader2 size={14} className="progress-indicator" /> : step.status === 'failed' ? <CircleAlert size={14} /> : step.status === 'done' ? <Check size={14} /> : <Minus size={14} />}</span>
      <div><span className="progress-label">{step.label}</span>
        <span className="progress-meta">{step.status === 'done' ? 'OK' : step.status === 'failed' ? 'Error' : step.status}</span>
        {step.summary && <p>{step.summary}</p>}
        {step.children?.length ? <StepList steps={step.children} /> : null}
      </div>
    </li>)}
  </ol>
}
