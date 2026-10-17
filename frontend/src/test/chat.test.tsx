import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import App from '../App'
import { ChatPanel } from '../components/ChatPanel'
import { DiffView } from '../components/DiffView'
import { EmailDraftModal } from '../components/EmailDraftModal'
import { EnquiryEditor } from '../components/EnquiryEditor'
import { EvidenceViewer } from '../components/EvidenceViewer'
import { RefusalCard } from '../components/RefusalCard'
import { reportToMarkdown } from '../export'
import mockReport from '../mock/report.json'
import type { Card, ChatResponse, ReportBody, ReportDiff, RunEvent, SessionDetail } from '../types'

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

const session = (over: Partial<SessionDetail> = {}): SessionDetail => ({
  id: 's1',
  title: 'Dairy line',
  case_id: null,
  created_at: '2026-10-17T09:00:00Z',
  messages: [
    {
      id: 'm1',
      session_id: 's1',
      role: 'user',
      kind: 'enquiry',
      text: 'Earlier enquiry text',
      run_id: 'r1',
      created_at: '2026-10-17T09:00:00Z',
    },
  ],
  reports: [{ version: 1, run_id: 'r1' }],
  ...over,
})

class FakeEventSource {
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
  emit(event: Partial<RunEvent> & Pick<RunEvent, 'type'>) {
    const full: RunEvent = { run_id: 'r2', seq: 0, ts: '', stage: null, payload: {}, ...event }
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(full) }))
  }
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

// ---------------------------------------------------------------- ChatPanel

describe('ChatPanel', () => {
  it('ChatPanel posts message and renders answer', async () => {
    const answer: ChatResponse = {
      kind: 'answer',
      text: 'The silica fiber does not transmit the MIR range.',
      cited_ids: ['S02-p06-visnir-silica'],
      tool_calls: [{ name: 'check_fiber_window' }],
      proposed_facts: [],
    }
    const fetchMock = routeFetch({
      '/api/sessions/s1': () => session(),
      '/api/sessions/s1/messages': () => answer,
    })
    const onCite = vi.fn()
    render(
      withQuery(
        <ChatPanel sessionId="s1" report={report} citations={{ 'S02-p06-visnir-silica': 'S02 p.6' }} onCite={onCite} />,
      ),
    )

    expect(await screen.findByText('Earlier enquiry text')).toBeInTheDocument()

    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Can MIR run over the fiber?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(await screen.findByText(answer.text)).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions/s1/messages',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'Can MIR run over the fiber?' }) }),
    )
    const log = screen.getByRole('log', { name: 'Chat history' })
    expect(within(log).getByText('Can MIR run over the fiber?')).toBeInTheDocument()
    expect(within(log).getByText('check_fiber_window')).toBeInTheDocument()

    fireEvent.click(within(log).getByRole('button', { name: 'Show source S02 p.6' }))
    expect(onCite).toHaveBeenCalledWith('S02-p06-visnir-silica')

    // Suggestion chips under the answer fill the input (they never send on their own).
    const chips = within(log).getByRole('group', { name: 'Suggestions' })
    const first = within(chips).getAllByRole('button')[0]
    fireEvent.click(first)
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(first.textContent)
    expect(fetchMock.mock.calls.filter(([u]) => String(u) === '/api/sessions/s1/messages')).toHaveLength(1)
  })

  it('a new-run response streams the run and then shows the diff', async () => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    const diff: ReportDiff = {
      status: { from: 'INSUFFICIENT_INFORMATION', to: 'PROVISIONAL' },
      verdict: null,
      recommendations: { added: [], removed: [], changed: [] },
      questions: { resolved: ['Distance to the analyzer?'], new: [] },
      risks: { added: [], removed: [] },
    }
    const fetchMock = routeFetch({
      '/api/sessions/s1': () => session(),
      '/api/sessions/s1/messages': () => ({ kind: 'run', run_id: 'r2' }),
      '/api/sessions/s1/diff?from=1&to=2': () => diff,
    })
    const onRunCompleted = vi.fn()
    render(withQuery(<ChatPanel sessionId="s1" onRunCompleted={onRunCompleted} />))
    await screen.findByText('Earlier enquiry text')

    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'The analyzer stands next to the line.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(await screen.findByText('New version v2 running…')).toBeInTheDocument()
    const es = FakeEventSource.instances.find((e) => e.url === '/api/runs/r2/events')!
    expect(es).toBeDefined()
    act(() => {
      es.emit({ type: 'stage_started', stage: 'scope', seq: 0 })
      es.emit({ type: 'run_completed', seq: 1, payload: { status: 'PROVISIONAL' } })
    })

    const region = await screen.findByRole('region', { name: 'Changes from v1 to v2' })
    expect(within(region).getByRole('group', { name: 'Decision status' })).toHaveTextContent('Provisional')
    expect(within(region).getByText('Distance to the analyzer?')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/diff?from=1&to=2', expect.anything())
    expect(onRunCompleted).toHaveBeenCalledWith('r2')
  })

  it('a refused message shows the reason and suggestions', async () => {
    routeFetch({
      '/api/sessions/s1': () => session(),
      '/api/sessions/s1/messages': () => ({
        kind: 'refused',
        reason: 'This is not about in-line spectroscopy.',
        suggestions: ['Ask about the fiber link for the recommended method.'],
      }),
    })
    render(withQuery(<ChatPanel sessionId="s1" />))
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Tell me a joke' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const card = await screen.findByRole('alert')
    expect(card).toHaveTextContent('This is not about in-line spectroscopy.')
    fireEvent.click(within(card).getByRole('button', { name: 'Ask about the fiber link for the recommended method.' }))
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Ask about the fiber link for the recommended method.')
  })
})

// ---------------------------------------------------------------- RefusalCard

describe('RefusalCard', () => {
  it('RefusalCard example fills editor', () => {
    function Harness() {
      const [text, setText] = useState('What is the weather tomorrow?')
      return (
        <>
          <EnquiryEditor value={text} onChange={setText} onSubmit={() => {}} />
          <RefusalCard
            reason="The enquiry is not about a measurement task."
            label="OFF_TOPIC"
            suggestions={['We want to monitor fat content in milk in-line.', 'Can a probe measure moisture in powder?']}
            onExample={setText}
          />
        </>
      )
    }
    render(<Harness />)
    const card = screen.getByRole('alert')
    expect(card).toHaveTextContent('The enquiry is not about a measurement task.')
    expect(card).toHaveTextContent('Off topic')

    fireEvent.click(within(card).getByRole('button', { name: 'Can a probe measure moisture in powder?' }))
    expect(screen.getByRole('textbox', { name: 'Enquiry' })).toHaveValue('Can a probe measure moisture in powder?')
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
  it('⌘K opens the palette and "New enquiry" shows the editor', async () => {
    routeFetch({ '/api/sessions': () => [] })
    render(<App queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />)

    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    const palette = screen.getByRole('dialog', { name: 'Command palette' })
    fireEvent.change(within(palette).getByRole('combobox', { name: 'Command' }), { target: { value: 'new enq' } })
    const options = within(palette).getAllByRole('option')
    expect(options[0]).toHaveTextContent('New enquiry')
    fireEvent.keyDown(within(palette).getByRole('combobox', { name: 'Command' }), { key: 'Enter' })

    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull()
    expect(await screen.findByRole('textbox', { name: 'Enquiry' })).toBeInTheDocument()
  })
})
