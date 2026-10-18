import { Ban, CircleCheck } from 'lucide-react'
import type { Candidate, Recommendation } from '../types'
import { ROLE_LABEL } from '../labels'

interface MethodHeatmapProps {
  candidates: Candidate[]
  recommendations?: Recommendation[]
  /** Opens an evidence card (the Evidence tab). */
  onCite?: (cardId: string) => void
  /** Card ID → display citation (e.g. `S01 p.17`); falls back to the card ID. */
  citations?: Record<string, string>
  /** Stream id → name; a stream column appears only when the candidates span two or more streams. */
  streamNames?: Record<string, string>
}

/** Candidate methods in the engine's order, with status, reasons and cited evidence. */
export function MethodHeatmap({ candidates, recommendations = [], onCite, citations = {}, streamNames = {} }: MethodHeatmapProps) {
  const multiStream = new Set(candidates.map((r) => r.stream_id)).size > 1

  if (candidates.length === 0) return <p className="rs-muted">No candidate methods from the rule engine.</p>

  return (
    <div className="hm">
      <div className="tbl-wrap">
        <table aria-label="Candidate methods" className="tbl hm-table">
          <thead>
            <tr>
              <th scope="col">Method</th>
              <th scope="col">Technique</th>
              {multiStream && <th scope="col">Stream</th>}
              <th scope="col">Status</th>
              <th scope="col">Why and evidence</th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((r) => {
              const rec = recommendations.find((rec) => rec.methods.includes(r.method) && rec.technique === r.technique)
              return (
                <tr key={r.key} data-blocked={r.blocked ? 'true' : undefined}>
                  <th scope="row" className="hm-method">
                    {r.method}
                  </th>
                  <td className="hm-tech">{r.technique}</td>
                  {multiStream && <td className="rs-stream-note">{streamNames[r.stream_id] ?? r.stream_id}</td>}
                  <td>
                    {r.blocked ? (
                      <span className="pill pill-bad">
                        <Ban size={11} strokeWidth={2} aria-hidden="true" />
                        Blocked
                      </span>
                    ) : (
                      <span className="pill pill-ok">
                        <CircleCheck size={11} strokeWidth={2} aria-hidden="true" />
                        {rec ? ROLE_LABEL[rec.role] : 'Open'}
                      </span>
                    )}
                  </td>
                  <td className="hm-why">
                    {r.reasons.length > 0 && (
                      <ul className="hm-reasons" data-blocked={r.blocked ? 'true' : undefined}>
                        {r.reasons.slice(0, 1).map((why, i) => (
                          <li key={i}>{why}</li>
                        ))}
                      </ul>
                    )}
                    {r.evidence_ids.length > 0 && (
                      <ul aria-label={`Evidence cards for ${r.method} · ${r.technique}`} className="hm-cards">
                        {[...new Set(r.evidence_ids)].map((id) => {
                          const label = citations[id] ?? id
                          return (
                            <li key={id}>
                              {onCite ? (
                                <button type="button" onClick={() => onCite(id)} aria-label={`Show source ${label}`} className="cite-sup">
                                  {label}
                                </button>
                              ) : (
                                <span className="cite-sup" data-static="true">
                                  {label}
                                </span>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
