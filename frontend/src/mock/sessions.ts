import type { CaseInfo, Session } from '../types'

// Offline fallback for the sidebar when no backend is running. IDs only: case texts are never embedded here.
export const mockCases: CaseInfo[] = [
  ...Array.from({ length: 8 }, (_, i): CaseInfo => ({ case_id: `D0${i + 1}`, title: `Development case D0${i + 1}`, kind: 'dev' })),
  ...Array.from({ length: 6 }, (_, i): CaseInfo => ({ case_id: `H0${i + 1}`, title: `Evaluation case H0${i + 1}`, kind: 'eval' })),
]

export const mockSessions: Session[] = [
  { id: 'mock-mine-1', title: 'Mock enquiry', case_id: null, created_at: '2026-10-17T00:00:00Z' },
]
