// Typed fetch client for the PRISM backend (docs/ARCHITECTURE.md §8). All paths are under /api;
// in development Vite proxies /api to http://localhost:8000.
import type {
  AssessmentReport,
  Card,
  CaseInfo,
  ChatResponse,
  EmailDraft,
  Health,
  ReportDiff,
  RunEvent,
  RunStarted,
  Session,
  SessionDetail,
  SpectralData,
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

async function send(path: string, init?: RequestInit, accept = 'application/json'): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { Accept: accept, ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
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
  return res
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return (await (await send(path, init)).json()) as T
}

async function requestText(path: string): Promise<string> {
  return (await send(path, undefined, 'text/markdown, text/plain')).text()
}

const post = <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) })

export const api = {
  health: () => request<Health>('/health'),
  cases: () => request<CaseInfo[]>('/cases'),
  listSessions: () => request<Session[]>('/sessions'),
  getSession: (id: string) => request<SessionDetail>(`/sessions/${encodeURIComponent(id)}`),
  createSession: (text: string, title?: string) => post<Session>('/sessions', { text, title }),
  startRun: (sessionId: string) => post<RunStarted>(`/sessions/${encodeURIComponent(sessionId)}/runs`, {}),
  getReport: (runId: string) => request<AssessmentReport>(`/runs/${encodeURIComponent(runId)}/report`),
  getReportMarkdown: (runId: string) => requestText(`/runs/${encodeURIComponent(runId)}/report.md`),
  postMessage: (sessionId: string, text: string) =>
    post<ChatResponse>(`/sessions/${encodeURIComponent(sessionId)}/messages`, { text }),
  getDiff: (sessionId: string, from: number, to: number) =>
    request<ReportDiff>(`/sessions/${encodeURIComponent(sessionId)}/diff?${new URLSearchParams({ from: String(from), to: String(to) })}`),
  emailDraft: (sessionId: string) => post<EmailDraft>(`/sessions/${encodeURIComponent(sessionId)}/email-draft`, {}),
  getCard: (id: string) => request<Card>(`/kb/cards/${encodeURIComponent(id)}`),
  getSpectral: () => request<SpectralData>('/kb/spectral'),
}

/** PNG of a source page with the card's quote highlighted (`GET /api/kb/pages/{doc}/{page}.png`). */
export const pageImageUrl = (doc: string, page: number, cardId?: string) =>
  `${API_BASE}/kb/pages/${encodeURIComponent(doc)}/${page}.png${cardId ? `?highlight=${encodeURIComponent(cardId)}` : ''}`

/**
 * True when the error means "no backend" rather than a real API answer: a network failure, or a 5xx
 * (the Vite dev proxy answers 500/502/504 when nothing listens on :8000).
 */
export const isOffline = (err: unknown) => !(err instanceof ApiError) || err.status >= 500

/** URL of the SSE stream for a run (consumed with `EventSource`). */
export const runEventsUrl = (runId: string) => `${API_BASE}/runs/${encodeURIComponent(runId)}/events`

/** Parse one SSE `data:` payload into a typed run event. */
export const parseRunEvent = (data: string): RunEvent => JSON.parse(data) as RunEvent
