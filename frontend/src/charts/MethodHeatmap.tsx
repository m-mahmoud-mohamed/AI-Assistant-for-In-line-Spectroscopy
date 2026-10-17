import { Fragment, useId, useMemo, useState } from 'react'
import { Ban, ChevronDown, ChevronRight, CircleCheck } from 'lucide-react'
import type { Candidate } from '../types'
import { scoreMatrix } from './scores'

interface MethodHeatmapProps {
  candidates: Candidate[]
  /** Opens an evidence card (the evidence viewer). */
  onCite?: (cardId: string) => void
  /** Card ID → display citation (e.g. `S01 p.17`); falls back to the card ID. */
  citations?: Record<string, string>
  /** Stream id → name; rows are tagged with their stream only when the candidates span two or more streams. */
  streamNames?: Record<string, string>
}

const HEADERS = { fit: 'Fit', optics: 'Optics', evidence: 'Evidence', link: 'Link', total: 'Total' } as const

const fmt = (n: number) => String(Number(n.toFixed(2)))

/**
 * Candidate scores as a heatmap table: rows are rule-engine candidates, cells shade (violet) by value within
 * the column. Each cell's tooltip carries the reasons; clicking a row lists its evidence cards.
 */
export function MethodHeatmap({ candidates, onCite, citations = {}, streamNames = {} }: MethodHeatmapProps) {
  const matrix = useMemo(() => scoreMatrix(candidates), [candidates])
  const [open, setOpen] = useState<string | null>(null)
  const baseId = useId()
  const multiStream = new Set(matrix.rows.map((r) => r.stream_id)).size > 1

  if (matrix.rows.length === 0) return <p className="rs-muted">No scored candidates from the rule engine.</p>

  return (
    <div className="hm">
      <div className="hm-scroll">
        <table aria-label="Candidate method scores" className="hm-table">
          <thead>
            <tr>
              <th scope="col" className="hm-th hm-th-left">
                Method
              </th>
              {matrix.columns.map((c) => (
                <th key={c} scope="col" className="hm-th">
                  {HEADERS[c]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((r) => {
              const expanded = open === r.key
              const detailId = `${baseId}-${r.key}`
              return (
                <Fragment key={r.key}>
                  {/* The whole row toggles; the button inside gives keyboard access (its click bubbles here). */}
                  <tr onClick={() => setOpen(expanded ? null : r.key)} className="hm-row">
                    <th scope="row" className="hm-name">
                      <button type="button" aria-expanded={expanded} aria-controls={detailId} className="hm-toggle">
                        {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                        {r.label}
                      </button>
                      {multiStream && <span className="rs-stream-note">{streamNames[r.stream_id] ?? r.stream_id}</span>}
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
                    </th>
                    {r.cells.map((c) => (
                      <td
                        key={c.column}
                        title={c.tooltip}
                        className="hm-cell tabular"
                        data-blocked={r.blocked ? 'true' : undefined}
                        data-total={c.column === 'total' ? 'true' : undefined}
                        style={r.blocked ? undefined : { background: `color-mix(in srgb, var(--violet) ${Math.round(5 + 36 * c.intensity)}%, #fff)` }}
                      >
                        {fmt(c.value)}
                      </td>
                    ))}
                  </tr>
                  {expanded && (
                    <tr id={detailId}>
                      <td colSpan={matrix.columns.length + 1} className="hm-detail">
                        {r.reasons.length > 0 && (
                          <ul className="rs-list">
                            {r.reasons.map((why, i) => (
                              <li key={i}>{why}</li>
                            ))}
                          </ul>
                        )}
                        <ul aria-label={`Evidence cards for ${r.label}`} className="hm-cards">
                          {r.evidence_ids.map((id) => {
                            const label = citations[id] ?? id
                            return (
                              <li key={id}>
                                {onCite ? (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      onCite(id)
                                    }}
                                    aria-label={`Show source ${label}`}
                                    className="cite-sup"
                                  >
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
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="rs-muted rs-note">Shade is relative within each column. Hover a cell for the reasons; select a row for its evidence cards.</p>
    </div>
  )
}
