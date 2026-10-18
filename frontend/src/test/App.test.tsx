import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeEventSource, detail, offlineFetch, renderApp, routeFetch } from './helpers'

const sessions = [
  { id: 's-old', title: 'Older enquiry', case_id: null, created_at: '2026-10-01T09:00:00Z' },
  { id: 's-new', title: 'Newer enquiry', case_id: null, created_at: '2026-10-02T09:00:00Z' },
]

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
})

describe('home', () => {
  it('shows the greeting, the composer and no predefined examples', async () => {
    routeFetch({ '/api/sessions': () => [] })
    renderApp()
    expect(screen.getByRole('heading', { level: 1, name: /Good (morning|afternoon|evening)\. Which process should we look inside\?/ })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Paste a client enquiry…' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Composer options' }))
    expect(screen.getByRole('switch', { name: 'Web' })).toHaveAttribute('title', 'Search verified external sources')
    expect(screen.getByRole('switch', { name: 'Deep' })).toHaveAttribute('aria-checked', 'false')
    // No case list, demo badge or mock report.
    expect(screen.queryByText(/D0[1-8]|H0[1-6]/)).toBeNull()
    expect(screen.queryByText(/Demo data|Replay mock|Pick a case/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /theme/i })).toBeNull()
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    await waitFor(() => expect(screen.getByRole('status', { name: 'PRISM connected' })).toBeInTheDocument())
  })

  it('offline: shows the notice and disables send, with no mock data', async () => {
    offlineFetch()
    renderApp()
    expect(await screen.findByText(/PRISM is unavailable\. Retry the connection; if/)).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'Paste a client enquiry…' }), { target: { value: 'Some enquiry' } })
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    expect(screen.queryByText('Demo data')).toBeNull()
    expect(screen.getByRole('status', { name: /PRISM is unavailable/ })).toBeInTheDocument()
  })

  it('has landmarks for the rail, the top bar, the main area', () => {
    routeFetch({ '/api/sessions': () => [] })
    renderApp()
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument()
    expect(screen.getByRole('banner')).toBeInTheDocument()
    expect(screen.getByRole('main')).toBeInTheDocument()
  })
})

describe('history', () => {
  it('lists the user\'s own sessions, newest first, and opens one as a thread', async () => {
    routeFetch({
      '/api/sessions': () => sessions,
      '/api/sessions/s-new': () => detail({ id: 's-new', title: 'Newer enquiry', reports: [] }),
    })
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Assessments' }))
    const list = await within(screen.getByRole('region', { name: 'Assessments' })).findAllByRole('listitem')
    expect(list[0]).toHaveTextContent('Newer enquiry')
    expect(list[1]).toHaveTextContent('Older enquiry')

    fireEvent.click(within(list[0]).getByRole('button'))
    expect(await screen.findByText('We want to monitor fat content in milk.')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Ask a follow-up question' })).toBeInTheDocument()
  })

  it('shows an empty state when there are no sessions', async () => {
    routeFetch({ '/api/sessions': () => [] })
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Assessments' }))
    expect(await screen.findByText('No assessments yet')).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('region', { name: 'Assessments' })).getByRole('button', { name: 'New enquiry' }))
    expect(await screen.findByRole('textbox', { name: 'Paste a client enquiry…' })).toBeInTheDocument()
  })
})
