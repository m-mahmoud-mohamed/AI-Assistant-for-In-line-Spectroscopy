import type { EnginePreview } from '../../types'

/**
 * The rules engine's candidates before any writer has run: method, technique and status, blocked ones struck through.
 * The cited reasons arrive with the report.
 */
export function EngineCandidates({ engine }: { engine: EnginePreview }) {
  const ranked = engine.candidates
  if (ranked.length === 0) return <p className="rs-muted">The rules engine found no candidate method for this enquiry.</p>
  return (
    <div className="ec">
      <ul className="ec-list" aria-label="Candidate methods from the rules engine">
        {ranked.map((c) => (
          <li key={`${c.method}|${c.technique}`} className="ec-row" data-blocked={c.blocked || undefined}>
            <span className="ec-name">{c.method}</span>
            <span className="ec-tech">{c.technique}</span>
            <span className="ec-status">{c.blocked ? 'Blocked' : 'Open'}</span>
            {c.reasons?.[0] && <p className="ec-reason">{c.reasons[0]}</p>}
          </li>
        ))}
      </ul>
    </div>
  )
}
