// Typed fetch client for the PRISM backend (docs/ARCHITECTURE.md §8). All paths are under /api;
// in development Vite proxies /api to http://localhost:8000.
import type {
  AssessmentReport,
  Card,
  CaseInfo,
  ChatMessage,
  Health,
  RunEvent,
  RunStarted,
  Session,
} from './types'

export const API_BASE = '/api'

export class ApiError extends Error {
  readonly status: number
  readonly path: string

  constructor(status: number, path: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.path = path
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = (await res.json()) as { detail?: unknown }
      if (typeof body.detail === 'string') detail = body.detail
    } catch {
      // non-JSON error body: keep the status text
    }
    throw new ApiError(res.status, path, `${res.status} ${detail}`)
  }
  return (await res.json()) as T
}

const post = <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) })

export const api = {
  health: () => request<Health>('/health'),
  cases: () => request<CaseInfo[]>('/cases'),
  listSessions: () => request<Session[]>('/sessions'),
  getSession: (id: string) => request<Session & { messages: ChatMessage[] }>(`/sessions/${encodeURIComponent(id)}`),
  createSession: (text: string, title?: string) => post<Session>('/sessions', { text, title }),
  startRun: (sessionId: string) => post<RunStarted>(`/sessions/${encodeURIComponent(sessionId)}/runs`, {}),
  getReport: (runId: string) => request<AssessmentReport>(`/runs/${encodeURIComponent(runId)}/report`),
  postMessage: (sessionId: string, text: string) =>
    post<ChatMessage & Partial<RunStarted>>(`/sessions/${encodeURIComponent(sessionId)}/messages`, { text }),
  getCard: (id: string) => request<Card>(`/kb/cards/${encodeURIComponent(id)}`),
}

/** URL of the SSE stream for a run (consumed with `EventSource`). */
export const runEventsUrl = (runId: string) => `${API_BASE}/runs/${encodeURIComponent(runId)}/events`

/** Parse one SSE `data:` payload into a typed run event. */
export const parseRunEvent = (data: string): RunEvent => JSON.parse(data) as RunEvent
