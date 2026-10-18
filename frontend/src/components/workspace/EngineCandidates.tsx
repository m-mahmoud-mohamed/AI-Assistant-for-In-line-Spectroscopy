import { formatScore, rankedCandidates } from '../../assistant/format'
import type { EnginePreview } from '../../types'

/**
 * The rules engine's candidates before any writer has run: method, technique and score, blocked ones struck through.
 * The per-column score breakdown and the cited reasons arrive with the report.
 */
export function EngineCandidates({ engine }: { engine: EnginePreview }) {
  const ranked = rankedCandidates(engine.candidates)
  if (ranked.length === 0) return <p className="rs-muted">The rules engine found no candidate method for this enquiry.</p>
  return (
    <div className="ec">
      <ul className="ec-list" aria-label="Candidate methods from the rules engine">
        {ranked.map((c) => (
          <li key={`${c.method}|${c.technique}`} className="ec-row" data-blocked={c.blocked || undefined}>
            <span className="ec-name">{c.method}</span>
            <span className="ec-tech">{c.technique}</span>
            <span className="ec-score tabular">{c.blocked ? 'Blocked by a rule' : formatScore(c.score)}</span>
          </li>
        ))}
      </ul>
      <p className="rs-muted rs-note">Scores come from the rules engine. The recommendations, with their cited reasons, follow as each section is verified.</p>
    </div>
  )
}
