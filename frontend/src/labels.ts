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

/** Short human names for the verifier's check ids (the backend's `Issue.check_id` and the report's compliance keys). */
export const CHECK_LABEL: Record<string, string> = {
  'C-IDS': 'Citation ids',
  'C-FINDINGS': 'Rule findings',
  'C-STATUS': 'Decision status',
  'C-SUPPORT': 'Claim support',
  'C-WEB-VERIFIED': 'Web sources verified',
  'P-MIN-RECOMMENDATION': 'Minimum recommendation',
  'P-DIRECT-ANSWER': 'Direct answer',
  'P-AFS-CITATION': 'AFS citation',
  'P-NO-NUMBERS': 'No invented numbers',
  'P-NO-GUARANTEE': 'No over-claiming',
  'P-NO-BAND-PICK': 'No band picking',
  'P-NO-SELF-ANSWER': 'No self-answered facts',
  'P-PLAN-COMPLETE': 'Complete plan',
  'P-QUESTIONS': 'Client questions',
  'P-LENGTH': 'Length limit',
  'P-SCOPE': 'Scope',
}

const sentence = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

/** Human name of a check id; unknown ids lose their `C-`/`P-`/`R-` prefix and read as a sentence. */
export function checkLabel(id: string): string {
  return CHECK_LABEL[id] ?? sentence(id.replace(/^[A-Z]-/, '').replaceAll(/[-_]/g, ' ').toLowerCase())
}

/** Human name of a rule-engine rule id (`R-SAMPLE-GEOMETRY` → "Sample geometry"). */
export const ruleLabel = checkLabel

/** Labels for the extracted-fact slots ("streams.s1.matrix" → "Matrix"); unknown slots read as a sentence. */
const SLOT_LABEL: Record<string, string> = {
  targets: 'Target',
  matrix: 'Matrix',
  optics: 'Optical state',
  distance: 'Distance to the analyser',
  use_context: 'Use context',
  requested_certainty: 'Requested certainty',
  process_conditions: 'Process conditions',
  concentration_range: 'Concentration range',
  accuracy_and_limits: 'Accuracy and limits',
  response_time: 'Response time',
  reference_method: 'Reference method',
  location_access: 'Location and access',
  existing_assets: 'Existing equipment',
  premises: 'Premises',
  domain: 'Domain',
}

/** Human label for a fact/unknown slot such as `streams.s1.targets`, `distance` or `process_conditions`. */
export function slotLabel(slot: string): string {
  const last = slot.split('.').pop() ?? slot
  return SLOT_LABEL[last] ?? sentence(last.replaceAll('_', ' '))
}
