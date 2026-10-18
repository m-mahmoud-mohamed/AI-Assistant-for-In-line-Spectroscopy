import { BadgeCheck, Ban, Check, Circle, CircleAlert, CircleHelp, Loader2, Minus, Network, WifiOff, type LucideIcon } from 'lucide-react'
import { STAGE_LABELS, type NodeStatus, type PipelineState } from '../../pipeline/reducer'
import { formatSeconds, stagesRun, totalSeconds } from '../../pipeline/status'
import type { WebSourceEvent } from '../../types'

const WEB_STATUS: Record<WebSourceEvent['status'], { label: string; icon: LucideIcon }> = {
  VERIFIED: { label: 'Verified', icon: BadgeCheck },
  UNVERIFIED: { label: 'Unverified', icon: CircleHelp },
  BLOCKED: { label: 'Blocked', icon: Ban },
  UNREACHABLE: { label: 'Unreachable', icon: WifiOff },
  SKIPPED: { label: 'Skipped', icon: Minus },
  ERROR: { label: 'Error', icon: CircleAlert },
}

/** Sources a web run considered, with a status icon each; the reason for a rejection shows on hover. */
export function WebSourceList({ sources }: { sources: WebSourceEvent[] }) {
  if (sources.length === 0) return null
  return (
    <ul className="web-list" aria-label="Web sources considered">
      {sources.map((w) => {
        const meta = WEB_STATUS[w.status] ?? WEB_STATUS.UNVERIFIED
        const Icon = meta.icon
        const name = w.domain || w.title || w.url
        return (
          <li key={w.url} className="web-src" data-status={w.status} title={w.reason ? `${meta.label}: ${w.reason}` : meta.label}>
            <Icon size={14} strokeWidth={2} aria-hidden="true" />
            <span className="web-src-name">{name}</span>
            <span className="web-src-status">{meta.label}</span>
            {w.reason && <span className="sr-only">{w.reason}</span>}
          </li>
        )
      })}
    </ul>
  )
}

/** The status glyph of a pipeline stage: spinner while running, a check when done, an alert for warnings and failures. */
export function StageIcon({ status }: { status: NodeStatus }) {
  return (
    <span className="step-icon" aria-hidden="true">
      {status === 'running' ? (
        <Loader2 size={16} strokeWidth={2} className="spin" style={{ color: 'var(--violet)' }} />
      ) : status === 'done' ? (
        <Check size={16} strokeWidth={2.25} style={{ color: 'var(--status-ok)' }} />
      ) : status === 'warning' || status === 'failed' || status === 'refused' ? (
        <CircleAlert size={16} strokeWidth={2} style={{ color: status === 'warning' ? 'var(--status-warn)' : 'var(--status-bad)' }} />
      ) : (
        <Circle size={16} strokeWidth={1.75} style={{ color: '#c4c6cf' }} />
      )}
    </span>
  )
}

/** While running: the stages as a compact vertical list (spinner on the active one); `web` only for web runs. */
export function PipelineSteps({ state }: { state: PipelineState }) {
  return (
    <ol className="steps" aria-label="Pipeline stages" aria-live="polite">
      {stagesRun(state).map((stage) => {
        const st = state.stages[stage]
        const secs = formatSeconds(st.seconds)
        return (
          <li key={stage} data-status={st.status} className="step">
            <StageIcon status={st.status} />
            <span className="step-name">{STAGE_LABELS[stage]}</span>
            <span className="sr-only">{st.status}</span>
            {secs && <span className="step-time tabular">{secs}</span>}
            {stage === 'web' && <WebSourceList sources={state.webSources} />}
          </li>
        )
      })}
    </ol>
  )
}

/** After completion: one line "Pipeline · 9 stages · 71 s · View graph" (10 stages for a web run). */
export function PipelineSummary({ state, onViewGraph }: { state: PipelineState; onViewGraph?: () => void }) {
  const total = totalSeconds(state)
  const count = stagesRun(state).length
  return (
    <p className="pipeline-line">
      <Network size={16} strokeWidth={1.75} aria-hidden="true" />
      <span>
        Pipeline · {count} stages{total !== null ? ` · ${formatSeconds(total)}` : ''}
      </span>
      {onViewGraph && (
        <button type="button" className="link-btn" onClick={onViewGraph}>
          View graph
        </button>
      )}
    </p>
  )
}
