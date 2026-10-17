import type { ChatMessage, DecisionStatus, SessionDetail } from '../../types'

const STATUS_PILL: Record<DecisionStatus, { label: string; tone: string }> = {
  PROVISIONAL: { label: 'Provisional', tone: 'pill-info' },
  INSUFFICIENT_INFORMATION: { label: 'Needs information', tone: 'pill-warn' },
  OUTSIDE_SUPPORTED_SCOPE: { label: 'Outside scope', tone: 'pill-bad' },
}

/** Status pill and version badge of a session, from its latest stored report (or its refusal). */
export function sessionSummary(detail: Pick<SessionDetail, 'reports' | 'messages'>): {
  pill: { label: string; tone: string } | null
  version: number | null
} {
  const reports = detail.reports ?? []
  const latest = reports.length ? reports.reduce((a, b) => (b.version > a.version ? b : a)) : null
  if (latest) {
    const pill = latest.decision_status ? STATUS_PILL[latest.decision_status] : null
    return { pill: pill ?? { label: 'Assessed', tone: 'pill-info' }, version: latest.version }
  }
  const refused = (detail.messages ?? []).some((m: ChatMessage) => m.role === 'assistant' && m.kind === 'refused')
  return { pill: refused ? { label: 'Outside scope', tone: 'pill-bad' } : { label: 'No report yet', tone: 'pill-muted' }, version: null }
}
