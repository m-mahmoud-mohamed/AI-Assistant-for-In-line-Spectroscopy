import type { Session, SessionGroup } from './types'

export const SESSION_GROUPS: SessionGroup[] = ['Dev', 'Eval', 'Mine']

/** Dev = development cases D01–D08, Eval = evaluation cases H01–H06, Mine = the user's own enquiries. */
export function sessionGroup(s: Session): SessionGroup {
  const id = s.case_id ?? ''
  if (/^D\d+$/.test(id)) return 'Dev'
  if (/^H\d+$/.test(id)) return 'Eval'
  return 'Mine'
}

export function groupSessions(sessions: Session[]): Record<SessionGroup, Session[]> {
  const out: Record<SessionGroup, Session[]> = { Dev: [], Eval: [], Mine: [] }
  for (const s of sessions) out[sessionGroup(s)].push(s)
  out.Dev.sort((a, b) => (a.case_id ?? '').localeCompare(b.case_id ?? ''))
  out.Eval.sort((a, b) => (a.case_id ?? '').localeCompare(b.case_id ?? ''))
  out.Mine.sort((a, b) => b.created_at.localeCompare(a.created_at))
  return out
}
