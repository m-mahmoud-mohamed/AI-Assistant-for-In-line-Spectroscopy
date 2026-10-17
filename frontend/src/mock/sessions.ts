import type { Session } from '../types'

// Offline fallback for the sidebar when no backend is running. IDs only: case texts are never embedded here.
const dev: Session[] = Array.from({ length: 8 }, (_, i) => {
  const id = `D0${i + 1}`
  return { id: `mock-${id}`, title: `Development case ${id}`, case_id: id, created_at: '2026-10-17T00:00:00Z' }
})

const evalCases: Session[] = Array.from({ length: 6 }, (_, i) => {
  const id = `H0${i + 1}`
  return { id: `mock-${id}`, title: `Evaluation case ${id}`, case_id: id, created_at: '2026-10-17T00:00:00Z' }
})

export const mockSessions: Session[] = [
  ...dev,
  ...evalCases,
  { id: 'mock-mine-1', title: 'Mock enquiry', case_id: null, created_at: '2026-10-17T00:00:00Z' },
]
