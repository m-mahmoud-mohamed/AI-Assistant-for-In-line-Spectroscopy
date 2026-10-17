import { Fragment, useId, useMemo, useState } from 'react'
import { Ban, ChevronDown, ChevronRight, CircleCheck } from 'lucide-react'
import type { Candidate } from '../types'
import { scoreMatrix } from './scores'

interface MethodHeatmapProps {
  candidates: Candidate[]
  /** Opens an evidence card (e.g. the Sources tab or evidence viewer). */
  onCite?: (cardId: string) => void
  /** Card ID → display citation (e.g. `S01 p.17`); falls back to the card ID. */
  citations?: Record<string, string>
}

const HEADERS = { fit: 'Fit', optics: 'Optics', evidence: 'Evidence', link: 'Link', total: 'Total' } as const

const fmt = (n: number) => String(Number(n.toFixed(2)))

/**
 * Candidate scores as a heatmap table: rows are rule-engine candidates, cells shade by value within
 * the column. Each cell's tooltip carries the reasons; clicking a row lists its evidence cards.
 */
export function MethodHeatmap({ candidates, onCite, citations = {} }: MethodHeatmapProps) {
  const matrix = useMemo(() => scoreMatrix(candidates), [candidates])
  const [open, setOpen] = useState<string | null>(null)
  const baseId = useId()

  if (matrix.rows.length === 0) return <p className="text-sm text-muted">No scored candidates from the rule engine.</p>

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto">
        <table aria-label="Candidate method scores" className="w-full border-separate border-spacing-0.5 text-sm">
          <thead>
            <tr>
              <th scope="col" className="px-2 py-1 text-left text-xs font-bold uppercase tracking-wide text-muted">
                Method
              </th>
              {matrix.columns.map((c) => (
                <th key={c} scope="col" className="px-2 py-1 text-center text-xs font-bold uppercase tracking-wide text-muted">
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
                  <tr onClick={() => setOpen(expanded ? null : r.key)} className="cursor-pointer">
                    <th scope="row" className="px-2 py-1 text-left font-medium">
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-controls={detailId}
                        className="inline-flex items-center gap-1 text-left hover:underline"
                      >
                        {expanded ? (
                          <ChevronDown size={14} aria-hidden="true" />
                        ) : (
                          <ChevronRight size={14} aria-hidden="true" />
                        )}
                        {r.label}
                      </button>
                      <span className="ml-2 font-mono text-xs text-muted">{r.stream_id}</span>
                      {r.blocked ? (
                        <span className="ml-2 inline-flex items-center gap-1 rounded border border-[var(--status-bad)] px-1.5 text-xs font-semibold">
                          <Ban size={11} aria-hidden="true" style={{ color: 'var(--status-bad)' }} />
                          Blocked
                        </span>
                      ) : (
                        <span className="ml-2 inline-flex items-center gap-1 rounded border border-[var(--status-ok)] px-1.5 text-xs font-semibold">
                          <CircleCheck size={11} aria-hidden="true" style={{ color: 'var(--status-ok)' }} />
                          Open
                        </span>
                      )}
                    </th>
                    {r.cells.map((c) => (
                      <td
                        key={c.column}
                        title={c.tooltip}
                        className={`rounded px-2 py-1 text-center font-mono ${r.blocked ? 'text-muted line-through' : ''} ${
                          c.column === 'total' ? 'font-bold' : ''
                        }`}
                        style={{
                          background: r.blocked
                            ? 'repeating-linear-gradient(45deg, transparent 0 4px, color-mix(in srgb, var(--status-bad) 14%, transparent) 4px 8px)'
                            : `color-mix(in srgb, var(--afs-prism-500) ${Math.round(8 + 62 * c.intensity)}%, transparent)`,
                        }}
                      >
                        {fmt(c.value)}
                      </td>
                    ))}
                  </tr>
                  {expanded && (
                    <tr id={detailId}>
                      <td colSpan={matrix.columns.length + 1} className="rounded bg-surface-raised px-3 py-2">
                        {r.reasons.length > 0 && (
                          <ul className="mb-2 list-disc pl-5 text-sm">
                            {r.reasons.map((why, i) => (
                              <li key={i}>{why}</li>
                            ))}
                          </ul>
                        )}
                        <ul aria-label={`Evidence cards for ${r.label}`} className="flex flex-wrap gap-2">
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
                                    className="rounded px-1 font-mono text-xs text-[var(--link)] underline decoration-dotted underline-offset-2 hover:bg-surface"
                                  >
                                    [{label}]
                                  </button>
                                ) : (
                                  <span className="font-mono text-xs text-muted">[{label}]</span>
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
      <p className="text-xs text-muted">
        Shade is relative within each column. Hover a cell for the reasons; select a row for its evidence cards.
      </p>
    </div>
  )
}
