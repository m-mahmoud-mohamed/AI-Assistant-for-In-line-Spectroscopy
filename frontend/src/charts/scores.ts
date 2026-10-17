// Candidate score matrix for the method heatmap: one row per rule-engine candidate
// (method · technique, per stream), columns fit / optics / evidence / link / total.
import { candidateScore, type Candidate } from '../types'

export const SCORE_COLUMNS = ['fit', 'optics', 'evidence', 'link', 'total'] as const
export type ScoreColumn = (typeof SCORE_COLUMNS)[number]

export interface ScoreCell {
  column: ScoreColumn
  value: number
  /** 0–1 relative to the highest value in this column (for the cell colour). */
  intensity: number
  /** Tooltip: the value plus the rule-engine reasons for the candidate. */
  tooltip: string
}

export interface ScoreRow {
  key: string
  label: string
  method: string
  technique: string
  stream_id: string
  blocked: boolean
  reasons: string[]
  evidence_ids: string[]
  cells: ScoreCell[]
}

export interface ScoreMatrix {
  columns: readonly ScoreColumn[]
  rows: ScoreRow[]
}

const fmt = (n: number) => String(Number(n.toFixed(2)))

const valueOf = (c: Candidate, col: ScoreColumn): number => (col === 'total' ? candidateScore(c) : c[col])

/** Rows sorted open-first, then by total (desc), then by key for a stable order. */
export function scoreMatrix(candidates: Candidate[]): ScoreMatrix {
  const max = Object.fromEntries(
    SCORE_COLUMNS.map((col) => [col, Math.max(0, ...candidates.map((c) => valueOf(c, col)))]),
  ) as Record<ScoreColumn, number>

  const rows = candidates.map((c): ScoreRow => {
    const label = `${c.method} · ${c.technique}`
    const why = [
      ...(c.blocked ? ['Blocked by a rule finding.'] : []),
      ...(c.reasons.length > 0 ? c.reasons : ['No deductions recorded.']),
    ].join('\n')
    const cells = SCORE_COLUMNS.map((column): ScoreCell => {
      const value = valueOf(c, column)
      const head =
        column === 'total'
          ? `${label} · total: ${[c.fit, c.optics, c.evidence, c.link].map(fmt).join(' + ')} = ${fmt(value)}`
          : `${label} · ${column}: ${fmt(value)}`
      return { column, value, intensity: max[column] > 0 ? value / max[column] : 0, tooltip: `${head}\n${why}` }
    })
    return {
      key: c.key,
      label,
      method: c.method,
      technique: c.technique,
      stream_id: c.stream_id,
      blocked: c.blocked,
      reasons: c.reasons,
      evidence_ids: c.evidence_ids,
      cells,
    }
  })

  const total = (r: ScoreRow) => r.cells[r.cells.length - 1].value
  rows.sort((a, b) => Number(a.blocked) - Number(b.blocked) || total(b) - total(a) || a.key.localeCompare(b.key))
  return { columns: SCORE_COLUMNS, rows }
}
