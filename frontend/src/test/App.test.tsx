import { QueryClient } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import App from '../App'
import type { CaseInfo, Session } from '../types'

const sessions: Session[] = [
  { id: 's-d02', title: 'Dev two', case_id: 'D02', created_at: '2026-10-01T10:00:00Z' },
  { id: 's-d01', title: 'Dev one', case_id: 'D01', created_at: '2026-10-01T09:00:00Z' },
  { id: 's-h01', title: 'Eval one', case_id: 'H01', created_at: '2026-10-01T09:00:00Z' },
  { id: 's-m01', title: 'My enquiry', case_id: null, created_at: '2026-10-02T09:00:00Z' },
]

const cases: CaseInfo[] = [
  { case_id: 'D02', title: 'Dev two', kind: 'dev' },
  { case_id: 'D01', title: 'Dev one', kind: 'dev' },
  { case_id: 'H01', title: 'Eval one', kind: 'eval' },
]

/** `/api/cases` answers the case list, every other path `body`. */
function mockFetch(body: unknown, ok = true) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
    new Response(JSON.stringify(ok && String(input) === '/api/cases' ? cases : body), { status: ok ? 200 : 500 }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const renderApp = () =>
  render(<App queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />)

describe('App', () => {
  it('App renders brand header', () => {
    mockFetch(sessions)
    renderApp()
    const header = screen.getByRole('banner')
    expect(within(header).getByAltText('Art Fiber Systems')).toHaveAttribute('src', '/brand/afs-logo-white.png')
    expect(within(header).getByRole('heading', { name: 'PRISM' })).toBeInTheDocument()
  })

  it('sidebar lists cases as Dev / Eval and sessions as Mine', async () => {
    const fetchMock = mockFetch(sessions)
    renderApp()

    const dev = await screen.findByRole('region', { name: 'Dev' })
    const evalGroup = screen.getByRole('region', { name: 'Eval' })
    const mine = screen.getByRole('region', { name: 'Mine' })

    expect(await within(dev).findByText('Dev one')).toBeInTheDocument()
    expect(within(dev).getAllByRole('button').map((b) => b.textContent)).toEqual(['D01Dev one', 'D02Dev two'])
    expect(within(evalGroup).getByText('Eval one')).toBeInTheDocument()
    expect(within(mine).getByText('My enquiry')).toBeInTheDocument()
    expect(within(dev).queryByText('My enquiry')).toBeNull()
    // Mine lists every stored session (case runs included), newest first.
    expect(within(mine).getAllByRole('button')).toHaveLength(sessions.length)
    expect(within(mine).getAllByRole('button')[0]).toHaveTextContent('My enquiry')
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions', expect.anything())
    expect(fetchMock).toHaveBeenCalledWith('/api/cases', expect.anything())
  })

  it('sidebar falls back to mock sessions when the backend is offline', async () => {
    mockFetch({ detail: 'down' }, false)
    renderApp()
    expect(await screen.findByText('Backend offline: showing mock sessions.')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Eval' })).getAllByRole('button')).toHaveLength(6)
  })

  it('theme toggle switches data-theme', () => {
    mockFetch(sessions)
    renderApp()
    const root = document.documentElement
    expect(root).toHaveAttribute('data-theme', 'dark')

    fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }))
    expect(root).toHaveAttribute('data-theme', 'light')

    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }))
    expect(root).toHaveAttribute('data-theme', 'dark')
  })
})
