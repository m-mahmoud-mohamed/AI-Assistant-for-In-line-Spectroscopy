// Thread pieces: web stage + web_source events, pipeline steps, source cards, follow-up answers, reveal rules.
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PipelineSteps, PipelineSummary } from '../components/thread/PipelineSteps'
import { SourceCards } from '../components/thread/SourceCards'
import { AnswerText } from '../components/thread/FollowUps'
import { applyEvents, initialPipelineState } from '../pipeline/reducer'
import { stagesRun, totalSeconds } from '../pipeline/status'
import { STAGES, type RunEvent, type RunEventType, type SourceRef, type Stage } from '../types'

let seq = 0
const ev = (type: RunEventType, stage: Stage | null, payload: Record<string, unknown> = {}): RunEvent => ({
  type,
  run_id: 'rw',
  seq: ++seq,
  ts: 1_760_000_000 + seq,
  stage,
  payload,
})

function webRun(withWeb = true): RunEvent[] {
  seq = 0
  const out: RunEvent[] = []
  const stages: Stage[] = withWeb ? ['scope', 'extract', 'normalise', 'rules', 'retrieve', 'web', 'draft', 'verify', 'repair', 'render'] : [...STAGES]
  for (const stage of stages) {
    out.push(ev('stage_started', stage))
    if (stage === 'web') {
      out.push(ev('web_source', 'web', { url: 'https://doi.org/10.1/x', title: 'A paper', status: 'VERIFIED', domain: 'doi.org', card_id: 'EXT-1', reason: '' }))
      out.push(ev('web_source', 'web', { url: 'https://blog.example/post', title: 'Blog', status: 'UNVERIFIED', domain: 'blog.example', card_id: null, reason: 'quote not found' }))
      out.push(ev('web_source', 'web', { url: 'https://shop.example', title: 'Shop', status: 'BLOCKED', domain: 'shop.example', card_id: null, reason: 'domain not allowed' }))
    }
    out.push(ev('stage_completed', stage, { seconds: 1 }))
  }
  out.push(ev('run_completed', 'render', { status: 'PROVISIONAL' }))
  return out
}

describe('web stage in the pipeline reducer', () => {
  it('has an idle optional web stage that is not counted unless the run emits it', () => {
    const s = applyEvents(webRun(false))
    expect(s.stages.web.status).toBe('idle')
    expect(stagesRun(s)).toHaveLength(9)
    expect(totalSeconds(s)).toBe(9)
  })

  it('records the web stage and its web_source events in order', () => {
    const s = applyEvents(webRun())
    expect(s.stages.web.status).toBe('done')
    expect(stagesRun(s)).toHaveLength(10)
    expect(stagesRun(s).indexOf('web')).toBe(stagesRun(s).indexOf('retrieve') + 1)
    expect(s.webSources.map((w) => w.status)).toEqual(['VERIFIED', 'UNVERIFIED', 'BLOCKED'])
    expect(s.webSources[0]).toMatchObject({ domain: 'doi.org', card_id: 'EXT-1' })
    expect(s.webSources[1].reason).toBe('quote not found')
  })

  it('a web_source event before any stage_started shows the stage, and a repeated url replaces its entry', () => {
    seq = 0
    const s = applyEvents([
      ev('web_source', null, { url: 'u1', title: 't', status: 'UNVERIFIED', domain: 'd', card_id: null, reason: '' }),
      ev('web_source', null, { url: 'u1', title: 't', status: 'VERIFIED', domain: 'd', card_id: 'EXT-2', reason: '' }),
    ])
    expect(s.webSources).toHaveLength(1)
    expect(s.webSources[0].status).toBe('VERIFIED')
    expect(stagesRun(s)).toContain('web')
  })

  it('replays are ignored', () => {
    const events = webRun()
    const s = applyEvents([...events, ...events])
    expect(s.webSources).toHaveLength(3)
  })
})

describe('PipelineSteps / PipelineSummary', () => {
  it('lists nine steps for a normal run and no web step', () => {
    render(<PipelineSteps state={applyEvents(webRun(false))} />)
    expect(within(screen.getByRole('list', { name: 'Pipeline stages' })).getAllByText(/^(Scope|Extract|Normalise|Rules|Retrieve|Draft|Verify|Repair|Render)$/)).toHaveLength(9)
    expect(screen.queryByText('Web')).toBeNull()
  })

  it('shows the Web step with a live list of sources and statuses; the reason is the hover title', () => {
    render(<PipelineSteps state={applyEvents(webRun())} />)
    expect(screen.getByText('Web')).toBeInTheDocument()
    const list = screen.getByRole('list', { name: 'Web sources considered' })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('doi.org')
    expect(items[0]).toHaveTextContent('Verified')
    expect(items[1]).toHaveAttribute('title', 'Unverified: quote not found')
    expect(items[2]).toHaveTextContent('Blocked')
  })

  it('the summary counts the stages actually run', () => {
    const { unmount } = render(<PipelineSummary state={applyEvents(webRun(false))} />)
    expect(screen.getByText(/Pipeline · 9 stages/)).toBeInTheDocument()
    unmount()
    render(<PipelineSummary state={applyEvents(webRun())} onViewGraph={vi.fn()} />)
    expect(screen.getByText(/Pipeline · 10 stages/)).toBeInTheDocument()
  })

  it('an idle state still lists the nine required steps', () => {
    render(<PipelineSteps state={initialPipelineState('x')} />)
    expect(within(screen.getByRole('list', { name: 'Pipeline stages' })).getAllByRole('listitem')).toHaveLength(9)
  })
})

describe('SourceCards', () => {
  const afs: SourceRef = { id: 'S01-p14-blend-potency', citation: 'S01 p.14', quote: 'q', scope: 'lab_study', url: null }
  const web: SourceRef = {
    id: 'EXT-1',
    citation: 'Smith 2024',
    quote: 'q',
    scope: 'external',
    url: 'https://doi.org/10.1/x',
    verification: {
      status: 'VERIFIED',
      checks: {},
      match_kind: 'exact',
      match_score: 1,
      domain: 'doi.org',
      domain_tier: 'peer_reviewed',
      content_sha256: 'x',
      retrieved_at: '2026-10-17',
      url: 'https://doi.org/10.1/x',
      doi: '10.1/x',
      notes: [],
    },
  }

  it('shows plain-words scope labels and use counts, and opens a card', () => {
    const onOpen = vi.fn()
    render(<SourceCards sources={[afs]} counts={{ 'S01-p14-blend-potency': 2 }} onOpen={onOpen} onMore={vi.fn()} />)
    const card = screen.getByRole('button', { name: 'Open source Blend potency, S01 p.14' })
    // titled by topic; the slide code moves to the meta line
    expect(card.querySelector('.clamp-2')).toHaveTextContent('Blend potency')
    expect(card.querySelector('.source-meta')).toHaveTextContent('S01 p.14 · AFS lab study')
    expect(card).toHaveTextContent('• 2')
    fireEvent.click(card)
    expect(onOpen).toHaveBeenCalledWith('S01-p14-blend-potency')
  })

  it('a verified web source shows its domain and a Verified check; an AFS card does not', () => {
    render(<SourceCards sources={[web, afs]} counts={{}} onOpen={vi.fn()} onMore={vi.fn()} />)
    const w = screen.getByRole('button', { name: 'Open source doi.org, Smith 2024' })
    expect(w).toHaveTextContent('doi.org')
    expect(w).toHaveTextContent('Verified')
    expect(w).toHaveAttribute('data-verified', 'true')
    expect(screen.getByRole('button', { name: /Open source Blend potency/ })).not.toHaveTextContent('Verified')
  })

  it('"+N More" opens the sources list', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...afs, id: `S0${i}`, citation: `c${i}` }))
    const onMore = vi.fn()
    render(<SourceCards sources={many} counts={{}} onOpen={vi.fn()} onMore={onMore} />)
    fireEvent.click(screen.getByRole('button', { name: '+2 More' }))
    expect(onMore).toHaveBeenCalled()
  })

  it('blurs in only when animating (a fresh run); stored sessions render without motion classes', () => {
    const { container, unmount } = render(<SourceCards sources={[afs]} counts={{}} onOpen={vi.fn()} onMore={vi.fn()} />)
    expect(container.querySelector('.blur-in')).toBeNull()
    unmount()
    const fresh = render(<SourceCards sources={[afs]} counts={{}} onOpen={vi.fn()} onMore={vi.fn()} animate />)
    expect(fresh.container.querySelectorAll('.blur-in').length).toBeGreaterThanOrEqual(2)
  })
})

describe('AnswerText', () => {
  it('renders citation chips that call onCite and verified web-source chips as links', () => {
    const onCite = vi.fn()
    render(
      <AnswerText
        text="The silica fiber stops at 2.4 µm."
        citedIds={['S02-p06']}
        citations={{ 'S02-p06': 'S02 p.6' }}
        onCite={onCite}
        webSources={[{ url: 'https://doi.org/10.1/x', title: 'A paper', domain: 'doi.org' }]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Show source S02 p.6' }))
    expect(onCite).toHaveBeenCalledWith('S02-p06')
    const link = screen.getByRole('link', { name: /doi\.org/ })
    expect(link).toHaveAttribute('href', 'https://doi.org/10.1/x')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('reveals word by word only when asked', () => {
    const { container, unmount } = render(<AnswerText text="Two words" />)
    expect(container.querySelector('.reveal-word')).toBeNull()
    unmount()
    const fresh = render(<AnswerText text="Two words" reveal />)
    expect(fresh.container.querySelectorAll('.reveal-word')).toHaveLength(2)
  })
})
