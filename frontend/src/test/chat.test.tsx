import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import App from '../App'
import { DiffView } from '../components/DiffView'
import { EmailDraftModal } from '../components/EmailDraftModal'
import { EvidenceViewer } from '../components/EvidenceViewer'
import { RefusalCard } from '../components/RefusalCard'
import { reportToMarkdown } from '../export'
import mockReport from './fixtures/report.json'
import type { Card, ReportBody, ReportDiff } from '../types'

const report = mockReport as ReportBody

// ---------------------------------------------------------------- helpers

type Route = (init?: RequestInit) => unknown
/** Stub `fetch` with a URL → handler map; unknown URLs answer 404. */
function routeFetch(routes: Record<string, Route>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const handler = routes[url]
    if (!handler) return new Response(JSON.stringify({ detail: 'not found' }), { status: 404 })
    const body = handler(init)
    return typeof body === 'string'
      ? new Response(body, { status: 200 })
      : new Response(JSON.stringify(body), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function withQuery(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>
}

// ---------------------------------------------------------------- DiffView

describe('DiffView', () => {
  it('DiffView renders status and recommendation changes', () => {
    const diff: ReportDiff = {
      status: { from: 'INSUFFICIENT_INFORMATION', to: 'PROVISIONAL' },
      verdict: { from: 'NOT_YET', to: 'CONDITIONAL' },
      recommendations: {
        added: [{ methods: ['NIR'], technique: 'transflection probe', role: 'PRIMARY' }],
        removed: [{ methods: ['Raman'], technique: 'immersion probe', role: 'SCREENING' }],
        changed: [{ methods: ['MIR'], technique: 'ATR probe', from: 'PRIMARY', to: 'NOT_RECOMMENDED' }],
      },
      questions: { resolved: ['How far is the analyzer from the line?'], new: ['Which cleaning cycle is used?'] },
      risks: { added: ['Probe fouling'], removed: [] },
    }
    render(<DiffView diff={diff} from={1} to={2} />)
    const region = screen.getByRole('region', { name: 'Changes from v1 to v2' })

    const status = within(region).getByRole('group', { name: 'Decision status' })
    expect(status).toHaveTextContent('Insufficient information')
    expect(status).toHaveTextContent('Provisional')
    expect(within(region).getByRole('group', { name: 'Direct answer' })).toHaveTextContent('Not yet')

    const recs = within(region).getByRole('group', { name: 'Recommendations' })
    const added = within(recs).getByText('NIR · transflection probe').closest('li')!
    expect(added).toHaveTextContent('Added')
    expect(added).toHaveTextContent('Primary')
    expect(within(recs).getByText('Raman · immersion probe').closest('li')).toHaveTextContent('Removed')
    const changed = within(recs).getByText('MIR · ATR probe').closest('li')!
    expect(changed).toHaveTextContent('Changed')
    expect(changed).toHaveTextContent('Primary')
    expect(changed).toHaveTextContent('Not recommended')

    const questions = within(region).getByRole('group', { name: 'Questions' })
    expect(within(questions).getByText('How far is the analyzer from the line?').closest('li')).toHaveTextContent('Resolved')
    expect(within(questions).getByText('Which cleaning cycle is used?').closest('li')).toHaveTextContent('New')
    expect(within(region).getByRole('group', { name: 'Risks' })).toHaveTextContent('Probe fouling')
  })

  it('DiffView says so when nothing changed', () => {
    const empty: ReportDiff = {
      status: null,
      verdict: null,
      recommendations: { added: [], removed: [], changed: [] },
      questions: { resolved: [], new: [] },
      risks: { added: [], removed: [] },
    }
    render(<DiffView diff={empty} from={1} to={2} />)
    expect(screen.getByText('No changes between the two versions.')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------- RefusalCard

describe('RefusalCard', () => {
  it('shows the muted heading, the reason and suggestions that fill the composer', () => {
    const onExample = vi.fn()
    render(
      <RefusalCard
        reason="The enquiry is not about a measurement task."
        label="OFF_TOPIC"
        suggestions={['We want to monitor fat content in milk in-line.', 'Can a probe measure moisture in powder?']}
        onExample={onExample}
      />,
    )
    const card = screen.getByRole('alert')
    expect(within(card).getByRole('heading', { name: /Outside PRISM's scope/ })).toBeInTheDocument()
    expect(card).toHaveTextContent('The enquiry is not about a measurement task.')
    expect(card).toHaveTextContent('Off topic')

    fireEvent.click(within(card).getByRole('button', { name: 'Can a probe measure moisture in powder?' }))
    expect(onExample).toHaveBeenCalledWith('Can a probe measure moisture in powder?')
  })
})

// ---------------------------------------------------------------- Evidence viewer

describe('EvidenceViewer', () => {
  const card: Card = {
    id: 'S01-p10-nir-range',
    source: 'S01',
    page: 10,
    quote: 'Verbatim quote from the page.',
    claim: 'NIR covers the stated range.',
    scope: 'method_general',
    methods: ['NIR'],
    topics: [],
    status: 'accepted',
    url: null,
    retrieved_at: null,
    reviewed_by: null,
  }

  it('loads the card and the highlighted page image', async () => {
    const fetchMock = routeFetch({ '/api/kb/cards/S01-p10-nir-range': () => card })
    render(withQuery(<EvidenceViewer cardId="S01-p10-nir-range" />))

    expect(await screen.findByText('Verbatim quote from the page.')).toBeInTheDocument()
    expect(screen.getByText('S01 p.10')).toBeInTheDocument()
    expect(screen.getByText('Method (general)')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'S01 p.10 with the quote highlighted' })).toHaveAttribute(
      'src',
      '/api/kb/pages/S01/10.png?highlight=S01-p10-nir-range',
    )
    expect(fetchMock).toHaveBeenCalledWith('/api/kb/cards/S01-p10-nir-range', expect.anything())
  })

  it('falls back to the report source when the backend is offline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    render(
      withQuery(
        <EvidenceViewer
          cardId="S01-p10-nir-range"
          fallback={{ id: 'S01-p10-nir-range', citation: 'S01 p.10', quote: 'Quote from the report.', scope: 'method_general', url: null }}
        />,
      ),
    )
    expect(await screen.findByText('Quote from the report.')).toBeInTheDocument()
    expect(screen.getByText('S01 p.10')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------- exports

describe('exports', () => {
  it('Markdown export contains status, questions and recommendations', () => {
    const md = reportToMarkdown(report)
    expect(md).toContain('**Status:** Provisional')
    expect(md).toContain('## Clarification questions')
    expect(md).toContain('1. Question 1?')
    expect(md).toContain('NIR · diffuse reflection probe')
    expect(md).toContain('[AFS]')
  })

  it('e-mail draft modal shows the API draft and closes on Escape', async () => {
    routeFetch({ '/api/sessions/s1/email-draft': () => ({ text: 'Dear customer, thank you for your enquiry.' }) })
    const onClose = vi.fn()
    render(withQuery(<EmailDraftModal open sessionId="s1" report={report} onClose={onClose} />))
    const dialog = screen.getByRole('dialog', { name: 'Customer e-mail draft' })
    await waitFor(() =>
      expect(within(dialog).getByRole('textbox', { name: 'E-mail text' })).toHaveValue(
        'Dear customer, thank you for your enquiry.',
      ),
    )
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('e-mail draft falls back to a local draft with the open questions only', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    render(withQuery(<EmailDraftModal open sessionId={null} report={report} onClose={() => {}} />))
    const text = (await screen.findByRole('textbox', { name: 'E-mail text' })) as HTMLTextAreaElement
    await waitFor(() => expect(text.value).toContain('1. Question 1?'))
    expect(text.value).not.toContain('diffuse reflection probe')
    expect(screen.getByText(/generated locally/)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------- command palette

describe('command palette', () => {
  it('⌘K opens the palette; "New enquiry" returns to the home composer; no case commands exist', async () => {
    routeFetch({ '/api/sessions': () => [{ id: 's9', title: 'My dairy enquiry', case_id: null, created_at: '2026-10-17T09:00:00Z' }] })
    render(<App queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />)

    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    const palette = screen.getByRole('dialog', { name: 'Command palette' })
    const input = within(palette).getByRole('combobox', { name: 'Command' })
    expect(within(palette).queryByText(/Run case/)).toBeNull()
    await within(palette).findByText('My dairy enquiry')

    fireEvent.change(input, { target: { value: 'new enq' } })
    expect(within(palette).getAllByRole('option')[0]).toHaveTextContent('New enquiry')
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull()
    expect(await screen.findByRole('textbox', { name: 'Paste a client enquiry…' })).toBeInTheDocument()
  })
})
