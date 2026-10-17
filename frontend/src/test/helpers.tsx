// Shared test helpers: a routed fetch stub, a fake EventSource and an App renderer. No network, no mock data in the UI.
import { QueryClient } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { vi } from 'vitest'
import App from '../App'
import type { RunEvent, SessionDetail } from '../types'

export type Reply = { status?: number; body: unknown }
export type Handler = (init?: RequestInit) => Reply | unknown

/** Stub `fetch` with a "METHOD url" (or bare "url" for GET) → handler map; unknown routes answer 404. */
export function routeFetch(routes: Record<string, Handler>) {
  const calls: string[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const url = String(input)
    calls.push(`${method} ${url}`)
    const handler = routes[`${method} ${url}`] ?? (method === 'GET' ? routes[url] : undefined)
    if (!handler) return new Response(JSON.stringify({ detail: 'not found' }), { status: 404 })
    const out = handler(init)
    const reply: Reply = out && typeof out === 'object' && 'body' in out && 'status' in out ? (out as Reply) : { body: out }
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, calls }
}

export const offlineFetch = () => vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))

export class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly url: string
  readyState = 0
  onopen: ((e: Event) => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }
  addEventListener() {}
  removeEventListener() {}
  close() {
    this.readyState = 2
  }
  emit(event: Partial<RunEvent> & Pick<RunEvent, 'type' | 'seq'>, runId = 'r9') {
    const full: RunEvent = { run_id: runId, ts: 1_760_000_000.5, stage: null, payload: {}, ...event }
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(full) }))
  }
  static for(url: string) {
    return FakeEventSource.instances.find((e) => e.url === url)
  }
}

export const renderApp = () => render(<App queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />)

export const detail = (over: Partial<SessionDetail> = {}): SessionDetail => ({
  id: 's9',
  title: 'Dairy line fat content',
  case_id: null,
  created_at: '2026-10-17T09:00:00Z',
  messages: [
    {
      id: 'm1',
      session_id: 's9',
      role: 'user',
      kind: 'enquiry',
      text: 'We want to monitor fat content in milk.',
      run_id: 'r7',
      created_at: '2026-10-17T09:00:00Z',
    },
  ],
  reports: [{ version: 1, run_id: 'r7' }],
  ...over,
})
