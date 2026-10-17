// Display labels and citation formatting shared by the chat, diff, evidence and export views.
import type { Card, DecisionStatus, RecRole, ScopeLabel, Verdict } from './types'

export const STATUS_LABEL: Record<DecisionStatus, string> = {
  PROVISIONAL: 'Provisional',
  INSUFFICIENT_INFORMATION: 'Insufficient information',
  OUTSIDE_SUPPORTED_SCOPE: 'Outside supported scope',
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  YES: 'Yes',
  NO: 'No',
  NOT_YET: 'Not yet',
  CONDITIONAL: 'Conditional',
  NOT_APPLICABLE: 'No yes/no question',
}

export const ROLE_LABEL: Record<RecRole, string> = {
  PRIMARY: 'Primary',
  COMPARISON: 'Comparison',
  CONDITIONAL: 'Conditional',
  SCREENING: 'Screening',
  NOT_RECOMMENDED: 'Not recommended',
}

export const SCOPE_LABEL: Record<ScopeLabel | 'REFUSED', string> = {
  IN_SCOPE: 'In scope',
  PARTIAL: 'Partly in scope',
  OFF_TOPIC: 'Off topic',
  UNSAFE: 'Unsafe request',
  REFUSED: 'Refused',
}

/** Label for a known enum value, else the raw value with underscores turned into spaces. */
export function labelOf<K extends string>(map: Record<K, string>, value: string | null | undefined): string {
  if (!value) return ''
  return (map as Record<string, string>)[value] ?? value.replaceAll('_', ' ').toLowerCase()
}

/** Citation in the report format: `S01 p.10`, `S02 p.13`, `S01 Table 1 (p.6)`; external cards show their host. */
export function formatCitation(card: Pick<Card, 'source' | 'page' | 'url'>): string {
  if (card.source === 'TABLE') return `S01 Table 1 (p.${card.page})`
  if (card.source === 'EXT') {
    try {
      return card.url ? new URL(card.url).host : 'External source'
    } catch {
      return card.url ?? 'External source'
    }
  }
  return `${card.source} p.${card.page}`
}

/** Document and page of the rendered PDF page for a card (Table 1 lives in S01); null for external cards. */
export function cardPage(card: Pick<Card, 'source' | 'page'>): { doc: string; page: number } | null {
  if (card.source === 'EXT' || !card.page) return null
  return { doc: card.source === 'TABLE' ? 'S01' : card.source, page: card.page }
}
