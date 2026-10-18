import type { EnginePreview } from '../../types'
import { StatusBanner } from '../report/StatusBanner'

const TOP = 3

interface VerdictPreviewProps {
  verdict: EnginePreview | null
  /** What the answers picked so far would change (each option's `effect`). */
  effects?: string[]
}

/** The engine's verdict at a glance: the decision status and the leading candidate methods; updates as `verdict` events arrive. */
export function VerdictPreview({ verdict, effects = [] }: VerdictPreviewProps) {
  if (!verdict) {
    return (
      <div className="as-verdict" data-empty="true">
        <span className="as-muted">Verdict preview appears once the engine has run.</span>
      </div>
    )
  }
  const ranked = verdict.candidates
  const shown = ranked.slice(0, TOP)
  return (
    <div className="as-verdict" aria-label="Verdict preview" role="group">
      <div className="as-verdict-row">
        <StatusBanner status={verdict.status} />
        {ranked.length > TOP && <span className="as-muted tabular">+{ranked.length - TOP} more</span>}
      </div>
      {shown.length > 0 && (
        <ul className="as-cands" aria-label="Top candidates">
          {shown.map((c) => (
            <li key={`${c.method}|${c.technique}`} className="as-cand" data-blocked={c.blocked || undefined}>
              <span className="as-cand-name">{c.method}</span>
              {c.technique && <span className="as-cand-tech">{c.technique}</span>}
              <span className="as-cand-status">{c.blocked ? 'blocked' : 'open'}</span>
              {c.reasons?.[0] && <p className="as-cand-reason">{c.reasons[0]}</p>}
            </li>
          ))}
        </ul>
      )}
      {effects.length > 0 && (
        <p className="as-effects" aria-live="polite">
          <span className="as-effects-label">With your picks</span>
          {effects.join('; ')}
        </p>
      )}
    </div>
  )
}
