import type { Session } from './types'

/** The user's own sessions, newest first (History view and command palette). */
export function sortSessions(sessions: readonly Session[]): Session[] {
  return [...new Map(sessions.map((s) => [s.id, s])).values()].sort((a, b) => b.created_at.localeCompare(a.created_at))
}

/** Display title of a stored session. */
export const sessionTitle = (s: Pick<Session, 'title'>): string => s.title?.trim() || 'Untitled enquiry'

/** Short local date for lists, e.g. "17 Oct 2026, 16:39". */
export function formatSessionDate(iso: string, locale?: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(locale, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}
