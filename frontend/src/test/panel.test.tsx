import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { EvidenceViewer } from '../components/EvidenceViewer'
import { History } from '../components/history/History'
import { relativeDate } from '../components/history/relativeTime'
import { sessionSummary } from '../components/history/summary'
import { groupSources } from '../components/panel/sourceGroups'
import { statusLines } from '../components/shell/statusLines'
import { Tooltip } from '../components/shell/Tooltip'
import type { Card, Session, SourceRef } from '../types'
import { FakeEventSource, renderApp, routeFetch } from './helpers'

const withQuery = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>
)

const webCard: Card = {
  id: 'EXT-abc123',
  source: 'EXT',
  page: 0,
  quote: 'In-line NIR predicted blend potency within 1.5 percent.',
  claim: 'NIR predicts blend potency in-line.',
  scope: 'external',
  methods: ['NIR'],
  topics: [],
  status: 'web_verified',
  url: 'https://journal.example.org/paper',
  retrieved_at: '2026-10-17T10:00:00Z',
  reviewed_by: null,
  doi: '10.1000/xyz123',
  verification: {
    status: 'VERIFIED',
    checks: {
      reachable: true,
      quote_found: true,
      domain_allowed: true,
      metadata_consistent: true,
      quote_length: true,
      claim_numbers_in_quote: false,
      no_injection_markers: true,
    },
    match_kind: 'fuzzy',
    match_score: 96.4,
    domain: 'journal.example.org',
    domain_tier: 'peer_reviewed',
    content_sha256: 'deadbeef',
    retrieved_at: '2026-10-17T10:00:00Z',
    url: 'https://journal.example.org/paper',
    doi: '10.1000/xyz123',
    notes: [],
  },
}

describe('evidence viewer', () => {
  it('shows the verification checklist, tier, DOI and a safe link for a verified web card', async () => {
    const { fetchMock } = routeFetch({ '/api/kb/cards/EXT-abc123?run=r1': () => webCard })
    render(withQuery(<EvidenceViewer cardId="EXT-abc123" runId="r1" onBack={() => {}} />))

    expect(await screen.findByText(webCard.quote)).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/kb/cards/EXT-abc123?run=r1', expect.anything())
    expect(screen.getAllByText('journal.example.org').length).toBeGreaterThan(0)
    expect(screen.getByText('Peer-reviewed')).toBeInTheDocument()
    expect(screen.getByText('10.1000/xyz123')).toBeInTheDocument()

    const checks = screen.getByRole('list', { name: 'Verification checks' })
    expect(within(checks).getAllByRole('listitem')).toHaveLength(7)
    expect(checks).toHaveTextContent('Quote found in the page (fuzzy match, score 96%)')
    expect(within(checks).getByText(/Claim has numbers the quote does not contain/)).toBeInTheDocument()

    const open = screen.getByRole('link', { name: /Open source/ })
    expect(open).toHaveAttribute('href', 'https://journal.example.org/paper')
    expect(open).toHaveAttribute('target', '_blank')
    expect(open.getAttribute('rel')).toContain('noopener')
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument()
  })

  it('zooms the page image in a lightbox that Esc closes', async () => {
    const card: Card = { ...webCard, id: 'S01-p10-nir-range', source: 'S01', page: 10, scope: 'method_general', url: null, doi: null, verification: null }
    routeFetch({ '/api/kb/cards/S01-p10-nir-range': () => card })
    render(withQuery(<EvidenceViewer cardId="S01-p10-nir-range" />))
    fireEvent.click(await screen.findByRole('button', { name: 'Enlarge the source page' }))
    const box = screen.getByRole('dialog')
    expect(within(box).getByRole('img')).toHaveAttribute('src', '/api/kb/pages/S01/10.png?highlight=S01-p10-nir-range')
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

describe('sources grouping', () => {
  it('groups by document in S01…S05, Table 1, Web order', () => {
    const src = (id: string, scope: SourceRef['scope'] = 'method_general'): SourceRef => ({ id, citation: id, quote: 'q', scope, url: null })
    const groups = groupSources([src('EXT-1', 'external'), src('S02-p1'), src('TABLE-x'), src('S01-p1'), src('S01-p2')])
    expect(groups.map((g) => g.key)).toEqual(['S01', 'S02', 'TABLE', 'WEB'])
    expect(groups[0].sources).toHaveLength(2)
  })
})

describe('history', () => {
  const sessions: Session[] = [
    { id: 'a', title: 'Dairy fat content', case_id: null, created_at: '2026-10-01T09:00:00Z' },
    { id: 'b', title: 'Tablet blend potency', case_id: null, created_at: '2026-10-02T09:00:00Z' },
  ]
  const detailFor = (id: string) => ({
    ...sessions.find((s) => s.id === id)!,
    messages: [],
    reports: id === 'b' ? [{ version: 1, run_id: 'r1', decision_status: 'PROVISIONAL' }, { version: 2, run_id: 'r2', decision_status: 'INSUFFICIENT_INFORMATION' }] : [],
  })

  it('shows status and version badges and offers the shared search', async () => {
    routeFetch({ '/api/sessions/a': () => detailFor('a'), '/api/sessions/b': () => detailFor('b') })
    render(withQuery(<History onSearch={() => {}} onRetry={() => {}} sessions={sessions} loading={false} offline={false} selectedId={null} onOpen={() => {}} onNew={() => {}} />))
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(await screen.findByText('Needs information')).toBeInTheDocument()
    expect(screen.getByText('v2')).toBeInTheDocument()

    expect(screen.getByRole('button', { name: /Search assessments/ })).toBeInTheDocument()
    expect(screen.queryByRole('searchbox')).toBeNull()
  })

  it('empty state invites a first enquiry', () => {
    const onNew = vi.fn()
    render(withQuery(<History onSearch={() => {}} onRetry={() => {}} sessions={[]} loading={false} offline={false} selectedId={null} onOpen={() => {}} onNew={onNew} />))
    expect(screen.getByText('No assessments yet')).toBeInTheDocument()
    expect(screen.getByText(/paste a client enquiry to start/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /New enquiry/ }))
    expect(onNew).toHaveBeenCalled()
  })

  it('summarises refused sessions and formats relative dates', () => {
    expect(sessionSummary({ reports: [], messages: [{ id: '1', session_id: 'a', role: 'assistant', kind: 'refused', text: '', run_id: null, created_at: '' }] }).pill?.label).toBe('Outside scope')
    const now = new Date('2026-10-17T12:00:00Z')
    expect(relativeDate('2026-10-17T10:00:00Z', now, 'en')).toBe('2 hours ago')
    expect(relativeDate('2026-10-16T11:00:00Z', now, 'en')).toBe('yesterday')
    expect(relativeDate('2026-10-17T11:59:40Z', now, 'en')).toBe('just now')
  })
})

describe('command palette and rail', () => {
  it('Ctrl+K opens the palette and Esc closes it', async () => {
    FakeEventSource.instances = []
    routeFetch({ '/api/sessions': () => [] })
    renderApp()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const palette = await screen.findByRole('dialog', { name: 'Command palette' })
    const input = within(palette).getByRole('combobox', { name: 'Command' })
    expect(input).toHaveFocus()
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull())
  })

  it('status tooltip lists provider profile and remaining budget', () => {
    expect(statusLines('online', { profile: 'free', replay: false, budget: { minute: 18, day: 1990 } })).toEqual([
      'PRISM API connected',
      'Provider profile: free',
      'Requests left: 18 per minute · 1,990 per day',
    ])
    expect(statusLines('online', { profile: 'fake', replay: true })[2]).toBe('Requests left: not reported')
    expect(statusLines('offline')[0]).toMatch(/not reachable/)
  })

  it('tooltips wait 400 ms the first time and open instantly on the next neighbour', () => {
    vi.useFakeTimers()
    try {
      render(
        <>
          <Tooltip label="One">
            <button type="button">a</button>
          </Tooltip>
          <Tooltip label="Two">
            <button type="button">b</button>
          </Tooltip>
        </>,
      )
      const [a, b] = screen.getAllByRole('button')
      fireEvent.pointerEnter(a.parentElement!, { pointerType: 'mouse' })
      expect(screen.queryByRole('tooltip')).toBeNull()
      act(() => void vi.advanceTimersByTime(401))
      expect(screen.getByRole('tooltip')).toHaveTextContent('One')
      fireEvent.pointerLeave(a.parentElement!)
      fireEvent.pointerEnter(b.parentElement!, { pointerType: 'mouse' })
      expect(screen.getByRole('tooltip')).toHaveTextContent('Two')
      expect(screen.getByRole('tooltip')).toHaveAttribute('data-instant', 'true')
    } finally {
      vi.useRealTimers()
    }
  })
})
