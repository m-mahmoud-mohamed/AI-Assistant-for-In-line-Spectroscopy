import { useCallback, useState } from 'react'

export type ShellView = 'home' | 'thread' | 'history' | 'sources' | 'settings'
export const storage = {
  get(key: string): string | null {
    try { return localStorage.getItem(key) } catch { return null }
  },
  set(key: string, value: string) {
    try { localStorage.setItem(key, value) } catch { /* Storage may be disabled or full. */ }
  },
}

export function readRoute(): { view: ShellView; sessionId: string | null } {
  const path = window.location.pathname
  const match = /^\/a\/([^/]+)\/?$/.exec(path)
  if (match) {
    try { return { view: 'thread', sessionId: decodeURIComponent(match[1]) } } catch { /* Invalid URL. */ }
  }
  return { view: path === '/history' ? 'history' : path === '/sources' ? 'sources' : path === '/settings' ? 'settings' : 'home', sessionId: null }
}

export function writeRoute(view: ShellView, sessionId: string | null) {
  const path = view === 'thread' && sessionId ? `/a/${encodeURIComponent(sessionId)}` : view === 'thread' || view === 'home' ? '/' : `/${view}`
  if (window.location.pathname === path) return
  window.history.pushState(null, '', path)
}

/** Persist eagerly so a reload immediately after a keystroke cannot lose the draft. */
export function useSessionDraft(sessionId: string | null) {
  const key = `prism:draft:${sessionId ?? 'new'}`
  const [draft, setState] = useState(() => ({ key, text: storage.get(key) ?? '' }))
  if (draft.key !== key) setState({ key, text: storage.get(key) ?? '' })
  const setDraft = useCallback((text: string) => {
    storage.set(key, text)
    setState({ key, text })
  }, [key])
  return [draft.key === key ? draft.text : storage.get(key) ?? '', setDraft] as const
}
