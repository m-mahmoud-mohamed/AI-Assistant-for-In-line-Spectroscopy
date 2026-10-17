// Typed fetch client for the PRISM backend (docs/ARCHITECTURE.md §8). All paths are under /api;
// in development Vite proxies /api to http://localhost:8000.
import type {
  Card,
  CaseInfo,
  ChatResponse,
  EmailDraft,
  Health,
  LiveReport,
  RefusedReport,
  ReportDiff,
  RunEvent,
  RunReport,
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
  if (!res.ok) throw await apiError(res, path)
  return res
}

async function apiError(res: Response, path: string): Promise<ApiError> {
  let detail = res.statusText
  try {
    const body = (await res.json()) as { detail?: unknown }
    if (typeof body.detail === 'string') detail = body.detail
  } catch {
    // non-JSON error body: keep the status text
  }
  return new ApiError(res.status, path, `${res.status} ${detail}`)
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return (await (await send(path, init)).json()) as T
}

async function requestText(path: string): Promise<string> {
  return (await send(path, undefined, 'text/markdown, text/plain')).text()
}

const post = <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) })

/** A new session from free text (`{text, title}`) or from a case file (`{case_id}`). */
export type SessionInput = { text: string; title?: string } | { case_id: string }

/**
 * `GET /api/runs/{id}/report`. 200 → the report (with `findings` and `scope`); 422 with `refused` → the
 * refusal body; 409 (still running / failed) and every other error → ApiError.
 */
async function getReport(runId: string): Promise<RunReport> {
  const path = `/runs/${encodeURIComponent(runId)}/report`
  const res = await fetch(`${API_BASE}${path}`, { headers: { Accept: 'application/json' } })
  if (res.status === 422) {
    const body = (await res.clone().json().catch(() => null)) as Partial<RefusedReport> | null
    if (body?.refused) return { refused: true, scope: body.scope ?? null, markdown: body.markdown ?? '' }
  }
  if (!res.ok) throw await apiError(res, path)
  return (await res.json()) as LiveReport
}

/** 409 "run is still running": the report will exist later (a failed run also answers 409, but stays failed). */
export const isStillRunning = (err: unknown) =>
  err instanceof ApiError && err.status === 409 && !/run failed/i.test(err.message)

export const api = {
  health: () => request<Health>('/health'),
  cases: () => request<CaseInfo[]>('/cases'),
  listSessions: () => request<Session[]>('/sessions'),
  getSession: (id: string) => request<SessionDetail>(`/sessions/${encodeURIComponent(id)}`),
  createSession: (input: SessionInput) => post<Session>('/sessions', input),
  startRun: (sessionId: string, deep = false) =>
    post<RunStarted>(`/sessions/${encodeURIComponent(sessionId)}/runs`, { deep }),
  getReport,
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
