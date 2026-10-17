import type { CaseInfo, Session, SessionGroup } from './types'

export const SESSION_GROUPS: SessionGroup[] = ['Dev', 'Eval', 'Mine']

/** One sidebar entry: a case file (Dev/Eval, `GET /api/cases`) or a stored session (Mine, `GET /api/sessions`). */
export type SidebarItem =
  | { kind: 'case'; key: string; case_id: string; title: string }
  | { kind: 'session'; key: string; id: string; case_id: string | null; title: string; created_at: string }

/** Dev = development cases D01–D08, Eval = evaluation cases H01–H06, Mine = every stored session, newest first. */
export function groupSidebar(cases: CaseInfo[], sessions: Session[]): Record<SessionGroup, SidebarItem[]> {
  const caseItem = (c: CaseInfo): SidebarItem => ({ kind: 'case', key: `case-${c.case_id}`, case_id: c.case_id, title: c.title })
  const byId = (a: CaseInfo, b: CaseInfo) => a.case_id.localeCompare(b.case_id)
  return {
    Dev: cases.filter((c) => c.kind === 'dev').sort(byId).map(caseItem),
    Eval: cases.filter((c) => c.kind === 'eval').sort(byId).map(caseItem),
    Mine: [...sessions]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((s) => ({ kind: 'session', key: `session-${s.id}`, ...s })),
  }
}
