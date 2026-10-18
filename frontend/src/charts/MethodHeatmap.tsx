import { useMemo } from 'react'
import { Ban, CircleCheck } from 'lucide-react'
import type { Candidate } from '../types'
import { scoreMatrix } from './scores'

interface MethodHeatmapProps {
  candidates: Candidate[]
  /** Opens an evidence card (the Evidence tab). */
  onCite?: (cardId: string) => void
  /** Card ID → display citation (e.g. `S01 p.17`); falls back to the card ID. */
  citations?: Record<string, string>
  /** Stream id → name; a stream column appears only when the candidates span two or more streams. */
  streamNames?: Record<string, string>
}

const HEADERS = { fit: 'Fit', optics: 'Optics', evidence: 'Evidence', link: 'Link', total: 'Total' } as const

const fmt = (n: number) => String(Number(n.toFixed(2)))

/**
 * The candidate table: one row per rule-engine candidate (method, technique, stream when there are several), the four
 * scores and their total shaded (violet) by value within the column, open or blocked, and why: the rule engine's reasons
 * and the evidence cards behind the row. Rows are open-first, highest total first.
 */
export function MethodHeatmap({ candidates, onCite, citations = {}, streamNames = {} }: MethodHeatmapProps) {
  const matrix = useMemo(() => scoreMatrix(candidates), [candidates])
  const multiStream = new Set(matrix.rows.map((r) => r.stream_id)).size > 1

  if (matrix.rows.length === 0) return <p className="rs-muted">No scored candidates from the rule engine.</p>

  return (
    <div className="hm">
      <div className="tbl-wrap">
        <table aria-label="Candidate method scores" className="tbl hm-table">
          <thead>
            <tr>
              <th scope="col">Method</th>
              <th scope="col">Technique</th>
              {multiStream && <th scope="col">Stream</th>}
              {matrix.columns.map((c) => (
                <th key={c} scope="col" className="num">
                  {HEADERS[c]}
                </th>
              ))}
              <th scope="col">Status</th>
              <th scope="col">Why and evidence</th>
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((r) => (
              <tr key={r.key} data-blocked={r.blocked ? 'true' : undefined}>
                <th scope="row" className="hm-method">
                  {r.method}
                </th>
                <td className="hm-tech">{r.technique}</td>
                {multiStream && <td className="rs-stream-note">{streamNames[r.stream_id] ?? r.stream_id}</td>}
                {r.cells.map((c) => (
                  <td
                    key={c.column}
                    title={c.tooltip}
                    className="hm-cell num"
                    data-blocked={r.blocked ? 'true' : undefined}
                    data-total={c.column === 'total' ? 'true' : undefined}
                  >
                    <span className="hm-chip" style={r.blocked ? undefined : { background: `color-mix(in srgb, var(--violet) ${Math.round(5 + 36 * c.intensity)}%, var(--card))` }}>
                      {fmt(c.value)}
                    </span>
                  </td>
                ))}
                <td>
                  {r.blocked ? (
                    <span className="pill pill-bad">
                      <Ban size={11} strokeWidth={2} aria-hidden="true" />
                      Blocked
                    </span>
                  ) : (
                    <span className="pill pill-ok">
                      <CircleCheck size={11} strokeWidth={2} aria-hidden="true" />
                      Open
                    </span>
                  )}
                </td>
                <td className="hm-why">
                  {r.reasons.length > 0 ? (
                    <ul className="hm-reasons" data-blocked={r.blocked ? 'true' : undefined}>
                      {r.reasons.map((why, i) => (
                        <li key={i}>{why}</li>
                      ))}
                    </ul>
                  ) : (
                    <span className="rs-muted-inline">No deductions recorded.</span>
                  )}
                  {r.evidence_ids.length > 0 && (
                    <ul aria-label={`Evidence cards for ${r.method} · ${r.technique}`} className="hm-cards">
                      {r.evidence_ids.map((id) => {
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
            ))}
          </tbody>
        </table>
      </div>
      <p className="rs-muted rs-note">Shade is relative within each column; hover a score for the rule engine's reasons.</p>
    </div>
  )
}
