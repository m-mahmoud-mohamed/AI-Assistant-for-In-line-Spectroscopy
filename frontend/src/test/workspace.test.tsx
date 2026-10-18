// The report workspace: header and key facts, the tab bar (click, keyboard, number keys, URL hash), every tab's content,
// citation chips landing on the Evidence tab, the conversation / report toggle below 1180 px, printing, and the run states.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildReportModel, firstUnknowns } from '../components/workspace/model'
import { alternateRange, excitationLabel } from '../components/workspace/ranges'
import { citationFromId, plainText } from '../labels'
import { readHashTab } from '../state/tabs'
import { mockCompletedEvents } from './fixtures/events'
import mockFindings from './fixtures/findings.json'
import mockReport from './fixtures/report.json'
import mockSpectral from './fixtures/spectral.json'
import { FakeEventSource, detail, renderApp, routeFetch } from './helpers'
import type { ReportViewData, RuleFindings, SourceRef, Unknown } from '../types'

// jsdom cannot run plotly; the chart component is tested for its text output elsewhere.
vi.mock('plotly.js-dist-min', () => ({ default: {} }))
vi.mock('react-plotly.js/factory', () => ({ default: () => () => <div data-testid="plot" /> }))

const sources: SourceRef[] = [
  { id: 'S01-p17-nir-reflection-opaque', citation: 'S01 p.17', quote: 'NIR reflection suits opaque products.', scope: 'method_general', url: null },
  { id: 'S01-p10-nir-range', citation: 'S01 p.10', quote: 'NIR covers 780–2500 nm.', scope: 'method_general', url: null },
  { id: 'S02-p06-visnir-silica', citation: 'S02 p.6', quote: 'Silica fibers transmit VIS-NIR.', scope: 'lab_study', url: null },
]

const cite = (id: string) => [{ text: 'Cited statement.', claim_type: 'AFS' as const, evidence_ids: [id] }]

const richReport = (runId: string) => ({
  ...mockReport,
  case_id: '',
  title: 'Dairy line fat content',
  run_id: runId,
  created_at: '2026-10-17T09:00:00Z',
  kb_version: 'kb-test-1',
  profile: 'gwdg',
  model_ids: { generator: 'model-g' },
  prompt_hashes: { draft: 'abc123' },
  client_question: ['Can a probe follow the fat content of milk in-line?'],
  sources,
  premise_checks: [{ premise: 'Fat can be read through the pipe wall.', verdict: 'CONTRADICTED', explanation: cite('S01-p10-nir-range') }],
  requirements: {
    stated_facts: [
      { slot: 'streams.s1.targets', value: 'fat_content', quote: 'fat content in milk', stream_id: 's1' },
      { slot: 'distance', value: 'at_process', quote: 'next to the line', stream_id: null },
    ],
    key_unknowns: [
      { slot: 'process_conditions', why_it_matters: 'Needed for the feasibility plan.', stream_id: null },
      { slot: 'concentration_range', why_it_matters: 'Needed for the feasibility plan.', stream_id: null },
      { slot: 'streams.s1.optics', why_it_matters: 'Not stated by the client.', stream_id: 's1' },
      { slot: 'response_time', why_it_matters: 'Not stated by the client.', stream_id: null },
    ],
  },
  streams: [{ id: 's1', name: 'main', targets: [], matrix: { value: 'milk', quote: null }, optics: { value: 'unknown', quote: null } }],
  interpretations: [{ term: 'NIR-Sonde', canonical: 'NIR', kind: 'method', how: 'fuzzy', alternatives: ['MIR'], ambiguous: true }],
  spectral_ranges: [
    { method: 'NIR', nominal_range: '780–2500 nm', units: 'nm', excitation_nm: null, fiber_family_needed: 'VIS-NIR silica', caveat: cite('S01-p10-nir-range') },
    // a model dump leaked into the excitation field: it must not reach the table
    { method: 'Raman', nominal_range: '400–1100 nm', units: 'nm', excitation_nm: '{"decision_status": "PROVISIONAL"}', fiber_family_needed: 'low-OH silica', caveat: [] },
  ],
  risks: [{ risk: cite('S01-p17-nir-reflection-opaque'), effect: 'calibration_invalid_or_signal_swamped', mitigation: 'chemometrics_and_method_comparison' }],
  compliance: { 'C-IDS': true, 'P-SCOPE': false, 'P-LENGTH': true },
  findings: mockFindings,
  scope: { label: 'IN_SCOPE', reason: 'measurement enquiry', suggestions: [], tier: 'signals' },
})

/** `matchMedia` for a window `width` px wide: it answers the min-width / max-width queries (and no reduced motion). */
function viewport(width: number) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => {
      const min = /min-width:\s*(\d+)px/.exec(query)
      const max = /max-width:\s*(\d+)px/.exec(query)
      const matches = !/prefers-reduced-motion/.test(query) && (!min || width >= Number(min[1])) && (!max || width <= Number(max[1]))
      return { matches, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() }
    }),
  )
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
})
afterEach(() => vi.unstubAllGlobals())

const routes = (extra: Parameters<typeof routeFetch>[0] = {}) =>
  routeFetch({
    '/api/sessions': () => [detail()],
    '/api/kb/spectral': () => mockSpectral,
    '/api/sessions/s9': () => detail(),
    '/api/runs/r7/report': () => richReport('r7'),
    ...extra,
  })

async function openStored() {
  fireEvent.click(screen.getByRole('button', { name: 'Assessments' }))
  fireEvent.click(await screen.findByRole('button', { name: /Dairy line fat content/ }))
  await screen.findByRole('tablist', { name: 'Report sections' })
}

const tab = (name: RegExp | string) => screen.getByRole('tab', { name })
const panel = () => screen.getByRole('tabpanel')
const composer = () => screen.getByRole('textbox', { name: /Ask a follow-up question|Paste a client enquiry/ })

describe('header and key facts', () => {
  it('shows the title, version, status and verdict pills, the one-sentence answer and three key facts (the status is the pill, not a fourth tile)', async () => {
    routes()
    renderApp()
    await openStored()
    const pane = screen.getByRole('region', { name: 'Assessment report' })
    expect(within(pane).getByRole('heading', { level: 2, name: 'Dairy line fat content' })).toBeInTheDocument()
    expect(within(pane).getByText(/Report v1 · /)).toBeInTheDocument()
    expect(within(pane).getByRole('status')).toHaveTextContent('Status: Provisional')
    expect(within(pane).getByText('No yes/no question')).toBeInTheDocument()

    const facts = within(pane).getByRole('list', { name: 'Key facts' })
    const items = within(facts).getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('Primary method')
    expect(items[0]).toHaveTextContent('NIR')
    expect(items[0]).toHaveTextContent('diffuse reflection probe')
    expect(items[1]).toHaveTextContent('Open questions')
    expect(items[1]).toHaveTextContent('3')
    expect(items[1]).toHaveTextContent('4 key unknowns')
    // one of the three compliance checks fails: the strip says so
    expect(items[2]).toHaveTextContent('Checks')
    expect(items[2]).toHaveTextContent('2/3 passed')
    expect(items[2]).toHaveTextContent('1 failed')

    // a key fact leads to the tab that holds the detail
    fireEvent.click(within(items[1]).getByRole('button'))
    expect(tab(/^Questions/)).toHaveAttribute('aria-selected', 'true')
  })

  it('has the actions on the right: copy, export, e-mail draft, re-run (deep) and more; the e-mail draft opens its dialog', async () => {
    routes({ '/api/sessions/s9/email-draft': () => ({ text: 'Dear customer' }) })
    renderApp()
    await openStored()
    const pane = screen.getByRole('region', { name: 'Assessment report' })
    for (const name of ['Copy', 'Export', 'E-mail draft', 'Re-run (deep)', 'More actions']) {
      expect(within(pane).getByRole('button', { name })).toBeInTheDocument()
    }
    // one version only: no version select in the header
    expect(within(pane).queryByRole('button', { name: 'Switch report version' })).toBeNull()
    fireEvent.click(within(pane).getByRole('button', { name: 'E-mail draft' }))
    expect(await screen.findByRole('dialog', { name: 'Customer e-mail draft' })).toBeInTheDocument()
  })

  it('below 760 px the actions move into one menu next to the title', async () => {
    viewport(600)
    routes({ '/api/sessions/s9/email-draft': () => ({ text: 'Dear customer' }) })
    renderApp()
    await openStored()
    fireEvent.click(screen.getByRole('button', { name: 'Report' }))
    const pane = screen.getByRole('region', { name: 'Assessment report' })
    expect(within(pane).queryByRole('button', { name: 'Copy' })).toBeNull()
    expect(within(pane).queryByRole('button', { name: 'Re-run (deep)' })).toBeNull()
    fireEvent.click(within(pane).getByRole('button', { name: 'More actions' }))
    const menu = screen.getByRole('menu', { name: 'More actions' })
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Copy as Markdown',
      'Customer e-mail draft',
      'Re-run (deep)',
      'What changed',
    ])
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Customer e-mail draft' }))
    expect(await screen.findByRole('dialog', { name: 'Customer e-mail draft' })).toBeInTheDocument()
  })

  it('exports have one entry point, the Export menu: PDF of the shown version, Markdown, JSON, print and the e-mail draft', async () => {
    routes()
    renderApp()
    await openStored()
    const pane = screen.getByRole('region', { name: 'Assessment report' })
    fireEvent.click(within(pane).getByRole('button', { name: 'Export' }))
    expect(within(screen.getByRole('menu', { name: 'Export' })).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Download PDF (v1)', 'Download Markdown', 'Download JSON', 'Print…', 'Customer e-mail draft',
    ])
  })

  it('with several versions the header has a version select that switches the report', async () => {
    routes({
      '/api/sessions/s9': () => detail({ reports: [{ version: 1, run_id: 'r6' }, { version: 2, run_id: 'r7' }] }),
      '/api/runs/r6/report': () => ({ ...richReport('r6'), title: 'Older title' }),
    })
    renderApp()
    await openStored()
    const pane = screen.getByRole('region', { name: 'Assessment report' })
    const select = within(pane).getByRole('button', { name: 'Switch report version' })
    expect(select).toHaveTextContent('v2')
    fireEvent.click(select)
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Report v1' }))
    expect(await screen.findByRole('heading', { level: 2, name: 'Older title' })).toBeInTheDocument()
  })
})

describe('tabs', () => {
  it('is a WAI-ARIA tablist of eight tabs with counts, one selected, the others out of the tab order', async () => {
    routes()
    renderApp()
    await openStored()
    const list = screen.getByRole('tablist', { name: 'Report sections' })
    const tabs = within(list).getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['Overview', 'Methods6', 'Spectral2', 'Concept', 'Plan5', 'Questions3', 'Evidence3', 'Checks2/3'])
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1, -1])
    // each tab controls a labelled panel
    expect(tabs[0]).toHaveAttribute('aria-controls', 'tabpanel-overview')
    expect(panel()).toHaveAttribute('id', 'tabpanel-overview')
    expect(panel()).toHaveAttribute('aria-labelledby', 'tab-overview')
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
    // a failing checks tally reads as a problem
    expect(within(tabs[7]).getByText('2/3')).toHaveAttribute('data-tone', 'bad')
  })

  it('switches on click, writes the tab to the URL hash and reads it back', async () => {
    routes()
    renderApp()
    await openStored()
    fireEvent.click(tab(/^Methods/))
    expect(tab(/^Methods/)).toHaveAttribute('aria-selected', 'true')
    expect(tab(/^Overview/)).toHaveAttribute('aria-selected', 'false')
    expect(panel()).toHaveAttribute('aria-labelledby', 'tab-methods')
    expect(within(panel()).getByRole('table', { name: /Candidate method scores/ })).toBeInTheDocument()
    expect(location.hash).toBe('#tab=methods')
    expect(readHashTab()).toBe('methods')
  })

  it('moves with ←/→ (wrapping), Home and End, selecting as focus moves', async () => {
    routes()
    renderApp()
    await openStored()
    const list = screen.getByRole('tablist')
    tab(/^Overview/).focus()
    fireEvent.keyDown(list, { key: 'ArrowRight' })
    expect(tab(/^Methods/)).toHaveAttribute('aria-selected', 'true')
    expect(tab(/^Methods/)).toHaveFocus()
    expect(tab(/^Methods/).tabIndex).toBe(0)
    expect(tab(/^Overview/).tabIndex).toBe(-1)
    fireEvent.keyDown(list, { key: 'ArrowLeft' })
    fireEvent.keyDown(list, { key: 'ArrowLeft' })
    expect(tab(/^Checks/)).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(list, { key: 'ArrowRight' })
    expect(tab(/^Overview/)).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(list, { key: 'End' })
    expect(tab(/^Checks/)).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(list, { key: 'Home' })
    expect(tab(/^Overview/)).toHaveAttribute('aria-selected', 'true')
  })

  it('1–8 switch tabs unless focus is in a text field', async () => {
    routes()
    renderApp()
    await openStored()
    fireEvent.keyDown(document.body, { key: '3' })
    expect(tab(/^Spectral/)).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(document.body, { key: '8' })
    expect(tab(/^Checks/)).toHaveAttribute('aria-selected', 'true')
    // typing a digit in the composer is typing
    fireEvent.keyDown(composer(), { key: '2' })
    expect(tab(/^Checks/)).toHaveAttribute('aria-selected', 'true')
    // a shortcut with a modifier is not ours
    fireEvent.keyDown(document.body, { key: '1', ctrlKey: true })
    expect(tab(/^Checks/)).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(document.body, { key: '1' })
    expect(tab(/^Overview/)).toHaveAttribute('aria-selected', 'true')
  })

  it('remembers the active tab per session when leaving and coming back', async () => {
    routes()
    renderApp()
    await openStored()
    fireEvent.click(tab(/^Plan/))
    fireEvent.click(screen.getByRole('button', { name: 'Assessments' }))
    expect(location.hash).toBe('')
    fireEvent.click(await screen.findByRole('button', { name: /Dairy line fat content/ }))
    await screen.findByRole('tablist', { name: 'Report sections' })
    expect(tab(/^Plan/)).toHaveAttribute('aria-selected', 'true')
    expect(location.hash).toBe('#tab=plan')
  })

  it('fades the new panel in (opacity only) after a switch, never on first paint', async () => {
    routes()
    renderApp()
    await openStored()
    expect(panel()).not.toHaveAttribute('data-fade')
    fireEvent.click(tab(/^Questions/))
    expect(panel()).toHaveAttribute('data-fade', 'true')
  })

  it('the command palette lists the tabs and switches to one', async () => {
    routes()
    renderApp()
    await openStored()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const palette = await screen.findByRole('dialog', { name: 'Command palette' })
    fireEvent.change(within(palette).getByRole('combobox', { name: 'Command' }), { target: { value: 'evidence tab' } })
    fireEvent.keyDown(within(palette).getByRole('combobox', { name: 'Command' }), { key: 'Enter' })
    expect(tab(/^Evidence/)).toHaveAttribute('aria-selected', 'true')
  })
})

describe('overview', () => {
  it('leads with the question, the answer, a prominent contradicted premise, recommendationsand unknowns', async () => {
    routes()
    renderApp()
    await openStored()
    const overview = within(panel())
    expect(overview.getByRole('region', { name: "Client's question" })).toHaveTextContent('Can a probe follow the fat content of milk in-line?')
    expect(overview.getByRole('region', { name: 'Direct answer' })).toHaveTextContent('Start with a comparison study.')
    const premise = overview.getByRole('region', { name: 'Premise checks' })
    const problem = within(premise).getAllByRole('listitem')[0]
    expect(problem).toHaveTextContent('Contradicted')
    expect(problem).toHaveAttribute('data-problem', 'true')
    const recs = overview.getByRole('region', { name: 'Recommendations' })
    const rec = within(recs).getByRole('listitem', { name: 'NIR recommendation' })
    expect(rec).toHaveTextContent('diffuse reflection probe')
    expect(rec).toHaveTextContent('Primary')
    expect(overview.getByRole('region', { name: 'Open questions' })).toHaveTextContent('Question 1?')
    expect(overview.getByRole('region', { name: 'Key unknowns' })).toHaveTextContent('Process conditions')
    // nothing is shown twice: the first plan step is not repeated as a "next step"
    expect(overview.queryByRole('region', { name: 'Next step' })).toBeNull()
  })

  it('every block links to its tab', async () => {
    routes()
    renderApp()
    await openStored()
    const overview = within(panel())
    fireEvent.click(overview.getByRole('button', { name: /See all 3 questions/ }))
    expect(tab(/^Questions/)).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(tab(/^Overview/))
    fireEvent.click(within(panel()).getByRole('button', { name: /See all 4/ }))
    expect(tab(/^Concept/)).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(tab(/^Overview/))
    fireEvent.click(within(panel()).getByRole('button', { name: /Method detail/ }))
    expect(tab(/^Methods/)).toHaveAttribute('aria-selected', 'true')
  })

  it('has only supported premises plain, and no premise block at all when there are none', async () => {
    routes({ '/api/runs/r7/report': () => ({ ...richReport('r7'), premise_checks: [] }) })
    renderApp()
    await openStored()
    expect(within(panel()).queryByRole('region', { name: 'Premise checks' })).toBeNull()
  })
})

describe('citation chips open the Evidence tab on that source', () => {
  it('from the Overview', async () => {
    routes({ '/api/kb/cards/S01-p17-nir-reflection-opaque': () => ({ id: 'S01-p17-nir-reflection-opaque', source: 'S01', page: 17, quote: 'NIR reflection suits opaque products.', claim: 'c', scope: 'method_general', methods: [], topics: [], status: 'accepted', url: null, retrieved_at: null, reviewed_by: null }) })
    renderApp()
    await openStored()
    fireEvent.click(within(within(panel()).getByRole('region', { name: 'Recommendations' })).getAllByRole('button', { name: 'Show source S01 p.17' })[0])
    expect(tab(/^Evidence/)).toHaveAttribute('aria-selected', 'true')
    expect(location.hash).toBe('#tab=evidence')
    const viewer = await within(panel()).findByRole('article', { name: /^Evidence / })
    expect(within(viewer).getByText('NIR reflection suits opaque products.')).toBeInTheDocument()
    // the same source is marked in the list
    expect(within(panel()).getByRole('button', { name: /NIR reflection opaque/ })).toHaveAttribute('aria-current', 'true')
    // closing returns to the list without a selection
    fireEvent.click(within(viewer).getByRole('button', { name: 'Close evidence' }))
    expect(within(panel()).queryByRole('article', { name: /^Evidence / })).toBeNull()
  })

  it('from a chip in a follow-up answer in the conversation', async () => {
    routes({
      'POST /api/sessions/s9/messages': () => ({ kind: 'answer', text: 'Silica stops at 2.4 µm.', cited_ids: ['S02-p06-visnir-silica'], tool_calls: [], proposed_facts: [] }),
    })
    renderApp()
    await openStored()
    fireEvent.change(composer(), { target: { value: 'Does the fiber carry it?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const conversation = await screen.findByTestId('conversation')
    fireEvent.click(await within(conversation).findByRole('button', { name: 'Show source S02 p.6' }))
    expect(tab(/^Evidence/)).toHaveAttribute('aria-selected', 'true')
    expect(within(panel()).getByRole('button', { name: /Visnir silica/ })).toHaveAttribute('aria-current', 'true')
  })

  it('from the rail Sources button, with nothing selected', async () => {
    routes()
    renderApp()
    await openStored()
    fireEvent.click(screen.getByRole('button', { name: 'Sources' }))
    expect(location.pathname).toBe('/sources')
    expect(screen.getByRole('region', { name: 'Sources' })).toBeInTheDocument()
  })
})

describe('tab contents', () => {
  it('Methods: the candidate table with reasons in the table, and the recommendations in full', async () => {
    routes()
    renderApp()
    await openStored()
    fireEvent.click(tab(/^Methods/))
    const table = within(panel()).getByRole('table', { name: /Candidate method scores/ })
    expect(within(table).getByText('Blocked')).toBeInTheDocument()
    expect(table).toHaveTextContent('A long mid-IR fiber link is not documented')
    // cards the rule engine cites but the report does not list are labelled as pages, never as raw ids
    expect(within(table).getAllByRole('button', { name: 'Show source S02 p.13' }).length).toBeGreaterThan(0)
    expect(table.textContent).not.toMatch(/S02-p13/)
    const recs = within(panel()).getByRole('region', { name: 'Recommendations in detail' })
    expect(within(recs).getByRole('listitem', { name: 'NIR recommendation' })).toHaveTextContent('Why')
  })

  it('Spectral: the window chart and a ranges table with the other unit and no leaked excitation text', async () => {
    routes()
    renderApp()
    await openStored()
    fireEvent.click(tab(/^Spectral/))
    expect(await within(panel()).findByRole('figure', { name: /Spectral windows/ })).toBeInTheDocument()
    const table = within(panel()).getByRole('table', { name: 'Nominal spectral ranges' })
    const nir = within(table).getByRole('row', { name: /^NIR/ })
    expect(nir).toHaveTextContent('780–2500 nm')
    expect(nir).toHaveTextContent('≈ 12,821–4,000 cm⁻¹')
    expect(nir).toHaveTextContent('VIS-NIR silica')
    expect(within(nir).getByRole('button', { name: 'Show source S01 p.10' })).toBeInTheDocument()
    const raman = within(table).getByRole('row', { name: /^Raman/ })
    // a Raman shift is relative to the excitation line: no converted range, and the garbage field is not shown
    expect(raman).not.toHaveTextContent('≈')
    expect(table).not.toHaveTextContent('decision_status')
    expect(within(table).queryByRole('columnheader', { name: 'Excitation' })).toBeNull()
  })

  it('Concept: the concept per stream, the client\'s own words with human labels, unknowns with a shared reason once, and how terms were read', async () => {
    routes()
    renderApp()
    await openStored()
    fireEvent.click(tab(/^Concept/))
    const concept = within(panel()).getByRole('region', { name: 'Measurement concept' })
    expect(concept).toHaveTextContent('diffuse reflection')
    expect(concept).toHaveTextContent('VIS-NIR silica')
    // a single stream is never labelled
    expect(concept).not.toHaveTextContent(/\bmain\b/)

    const facts = within(panel()).getByRole('table', { name: 'Facts stated by the client' })
    expect(within(facts).getByRole('row', { name: /^Target/ })).toHaveTextContent('Fat content')
    expect(within(facts).getByRole('row', { name: /^Distance to the analyser/ })).toHaveTextContent('At process')
    expect(within(facts).getByText('“fat content in milk”')).toBeInTheDocument()
    expect(facts.textContent).not.toMatch(/streams\.s1|_/)

    const unknowns = within(panel()).getByRole('region', { name: 'Key unknowns' })
    expect(within(unknowns).getAllByText('Needed for the feasibility plan:')).toHaveLength(1)
    expect(within(unknowns).getByText('Process conditions')).toBeInTheDocument()
    expect(within(unknowns).getByText('Optical state')).toBeInTheDocument()
    expect(unknowns.textContent).not.toMatch(/streams\.s1/)

    const terms = within(panel()).getByRole('table', { name: "How the client's terms were read" })
    expect(terms).toHaveTextContent('“NIR-Sonde”')
    expect(terms).toHaveTextContent('close spelling')
    expect(within(terms).getByText('Ambiguous')).toBeInTheDocument()
  })

  it('Plan: every step, risks and assumptions in tables with the backend ids read as sentences, and the decision basis', async () => {
    routes()
    renderApp()
    await openStored()
    fireEvent.click(tab(/^Plan/))
    expect(within(panel()).getAllByRole('listitem', { name: /^Step / })).toHaveLength(5)
    expect(within(panel()).queryByRole('region', { name: 'Clarify first' })).toBeNull()
    const risks = within(panel()).getByRole('table', { name: 'Risks and mitigations' })
    expect(risks).toHaveTextContent('Calibration invalid or signal swamped')
    expect(risks).toHaveTextContent('Chemometrics and method comparison')
    expect(risks.textContent).not.toMatch(/_/)
    expect(within(panel()).getByRole('region', { name: 'Decision basis' })).toHaveTextContent('Error and bias on independent runs')
  })

  it('Questions: ranked, with what each changes; copy them all; take one into the follow-up box; ask in the e-mail draft', async () => {
    routes({ '/api/sessions/s9/email-draft': () => ({ text: 'Dear customer' }) })
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderApp()
    await openStored()
    fireEvent.click(tab(/^Questions/))
    const items = within(panel()).getAllByRole('listitem')
    expect(items.map((li) => within(li).getByRole('heading').textContent)).toEqual(['Question 1?', 'Question 2?', 'Question 3?'])
    expect(items[0]).not.toHaveTextContent('Changes:')
    expect(items[0]).toHaveTextContent('It decides the interface.')

    fireEvent.click(within(panel()).getByRole('button', { name: 'Copy all questions' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('1. Question 1?\n2. Question 2?\n3. Question 3?'))
    expect(await within(panel()).findByRole('button', { name: 'Copied' })).toBeInTheDocument()

    fireEvent.click(within(panel()).getByRole('button', { name: 'Use as follow-up: Question 2?' }))
    expect(composer()).toHaveValue('Client answer to "Question 2?": ')

    fireEvent.click(within(panel()).getByRole('button', { name: 'Ask in e-mail draft' }))
    expect(await screen.findByRole('dialog', { name: 'Customer e-mail draft' })).toBeInTheDocument()
    delete (navigator as unknown as Record<string, unknown>).clipboard
  })

  it('Evidence: sources by document with their use counts; a row opens the viewer; Back closes it', async () => {
    routes({ '/api/kb/cards/S01-p10-nir-range': () => ({ id: 'x' }) })
    renderApp()
    await openStored()
    fireEvent.click(tab(/^Evidence/))
    expect(within(panel()).getByText(/3 sources cited in this report/)).toBeInTheDocument()
    const s01 = within(panel()).getByRole('region', { name: /^S01/ })
    expect(within(s01).getAllByRole('button')).toHaveLength(2)
    expect(within(panel()).getByRole('region', { name: /^S02/ })).toBeInTheDocument()
    expect(within(panel()).getAllByText(/^\d+ uses?$/).length).toBeGreaterThan(0)
    fireEvent.click(within(s01).getByRole('button', { name: /NIR range/ }))
    const viewer = await within(panel()).findByRole('article', { name: /^Evidence / })
    expect(within(viewer).getByText('NIR covers 780–2500 nm.')).toBeInTheDocument()
    fireEvent.click(within(viewer).getByRole('button', { name: 'Back' }))
    expect(within(panel()).queryByRole('article', { name: /^Evidence / })).toBeNull()
  })

  it('Checks: compliance by human name (failures first), the pipeline trace with timings, rule findings and run details', async () => {
    routes()
    renderApp()
    await openStored()
    const es = FakeEventSource.for('/api/runs/r7/events')!
    act(() => void mockCompletedEvents('r7').forEach((e) => es.emit(e, 'r7')))
    fireEvent.click(tab(/^Checks/))
    const checks = within(within(panel()).getByRole('region', { name: 'Format and policy checks' })).getAllByRole('listitem')
    expect(checks[0]).toHaveTextContent('Scope') // the failing one first, by its human name
    expect(checks[0]).toHaveTextContent('Fail')
    expect(within(panel()).queryByText('P-SCOPE')).toBeNull()
    expect(within(panel()).getByText('2/3 passed')).toBeInTheDocument()

    const trace = within(panel()).getByRole('table', { name: 'Pipeline trace' })
    const rows = within(trace).getAllByRole('row')
    // header + nine stages + total
    expect(rows).toHaveLength(11)
    expect(within(trace).getByRole('row', { name: /Extract/ })).toHaveTextContent('3.1 s')
    expect(within(trace).getByRole('row', { name: /^Total/ })).toHaveTextContent(/\d+ s/)

    const verifier = within(panel()).getByRole('table', { name: 'Verifier findings' })
    expect(verifier).toHaveTextContent('Mock issue: segment has no evidence.')

    // rule findings and run details sit behind one-line rows
    const rules = within(panel()).getByRole('button', { name: /^Rule engine findings/ })
    expect(rules).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(rules)
    expect(within(panel()).getByRole('table', { name: 'Rule engine findings' })).toHaveTextContent('Fiber window')
    fireEvent.click(within(panel()).getByRole('button', { name: /^Run details/ }))
    expect(within(panel()).getByText('kb-test-1')).toBeInTheDocument()
    expect(within(panel()).getByText('model-g')).toBeInTheDocument()

    expect(within(trace).queryByRole('button')).toBeNull()
    expect(screen.queryByRole('dialog', { name: 'Pipeline graph' })).toBeNull()
  })

  it('Checks without a stored trace says so instead of showing an empty table', async () => {
    routes()
    renderApp()
    await openStored()
    fireEvent.click(tab(/^Checks/))
    expect(within(panel()).getAllByText('The run trace is not available.').length).toBeGreaterThan(0)
    expect(within(panel()).queryByRole('table', { name: 'Pipeline trace' })).toBeNull()
  })
})

describe('sections that are not in the report yet', () => {
  /** A report that has the answer, the methods and the sources but not the rest (it is still being written). */
  const partial = () => {
    const { feasibility_plan: _plan, risks: _risks, clarification_questions: _questions, measurement_concept: _concept, decision_basis: _basis, ...rest } = richReport('r7')
    return rest
  }

  it('a missing section shows a skeleton in its tab (and in the header and the tab counts), not nothing', async () => {
    routes({ '/api/runs/r7/report': () => partial() })
    renderApp()
    await openStored()
    const pane = screen.getByRole('region', { name: 'Assessment report' })
    // the header waits for the questions, not for what it has
    expect(within(within(pane).getByRole('list', { name: 'Key facts' })).getByRole('status', { name: 'Loading open questions' })).toBeInTheDocument()
    expect(within(pane).getByText('Status: Provisional')).toBeInTheDocument()
    // the tab counts of missing sections are left off
    expect(tab(/^Questions/).textContent).toBe('Questions')
    expect(tab(/^Plan/).textContent).toBe('Plan')
    expect(tab(/^Methods/).textContent).toBe('Methods6')

    // the Overview shows what it has and a skeleton for the rest
    const overview = within(panel())
    expect(overview.getByRole('region', { name: 'Direct answer' })).toHaveTextContent('Start with a comparison study.')
    expect(overview.getByRole('status', { name: 'Loading open questions' })).toBeInTheDocument()
    expect(overview.getByRole('region', { name: 'Open questions' })).toHaveAttribute('aria-busy', 'true')

    fireEvent.click(tab(/^Plan/))
    expect(within(panel()).getByRole('status', { name: 'Loading feasibility plan' })).toBeInTheDocument()
    expect(within(panel()).queryByRole('listitem', { name: /^Step / })).toBeNull()
    fireEvent.click(tab(/^Questions/))
    expect(within(panel()).getByRole('status', { name: 'Loading questions' })).toBeInTheDocument()
    expect(within(panel()).queryByRole('button', { name: 'Copy all questions' })).toBeNull()
    fireEvent.click(tab(/^Concept/))
    expect(within(panel()).getByRole('status', { name: 'Loading measurement concept' })).toBeInTheDocument()
    // a section that did arrive is there
    expect(within(panel()).getByRole('table', { name: 'Facts stated by the client' })).toBeInTheDocument()
  })

  it('when the run ends, a section that never came is not a skeleton any more', async () => {
    routes({ '/api/runs/r7/report': () => partial() })
    renderApp()
    await openStored()
    fireEvent.click(tab(/^Questions/))
    expect(within(panel()).getByRole('status', { name: 'Loading questions' })).toBeInTheDocument()
    const es = FakeEventSource.for('/api/runs/r7/events')!
    act(() => void es.emit({ type: 'run_completed', stage: 'render', seq: 0, payload: { status: 'PROVISIONAL' } }, 'r7'))
    expect(await within(panel()).findByText(/No clarification questions/)).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: /^Loading/ })).toBeNull()
    expect(screen.getByRole('region', { name: 'Assessment report' }).querySelector('[aria-busy="true"]')).toBeNull()
  })

  it('while the run is in flight the rule engine, compliance and sources are waited for too', async () => {
    routes({ '/api/runs/r7/report': () => ({ ...richReport('r7'), findings: undefined, compliance: undefined, sources: undefined }) })
    renderApp()
    await openStored()
    const es = FakeEventSource.for('/api/runs/r7/events')!
    act(() => void es.emit({ type: 'stage_started', stage: 'draft', seq: 0 }, 'r7'))
    fireEvent.click(tab(/^Methods/))
    expect(within(panel()).getByRole('status', { name: 'Loading candidate methods' })).toBeInTheDocument()
    fireEvent.click(tab(/^Evidence/))
    expect(within(panel()).getByRole('status', { name: 'Loading sources' })).toBeInTheDocument()
    fireEvent.click(tab(/^Checks/))
    expect(within(panel()).getByRole('status', { name: 'Loading format and policy checks' })).toBeInTheDocument()
    expect(within(panel()).getByRole('status', { name: 'Loading rule engine findings' })).toBeInTheDocument()
    expect(within(within(screen.getByRole('region', { name: 'Assessment report' })).getByRole('list', { name: 'Key facts' })).getByRole('status', { name: 'Loading checks' })).toBeInTheDocument()

    act(() => void es.emit({ type: 'run_completed', stage: 'render', seq: 1, payload: { status: 'PROVISIONAL' } }, 'r7'))
    expect(await within(panel()).findByText(/No compliance checks are stored/)).toBeInTheDocument()
    expect(within(panel()).queryByRole('status', { name: /^Loading/ })).toBeNull()
  })
})

describe('below 1180 px', () => {
  it('has no toggle in the wide workspace: both panes are there', async () => {
    routes()
    renderApp()
    await openStored()
    expect(screen.queryByRole('group', { name: 'Show' })).toBeNull()
    expect(screen.getByTestId('conversation')).toBeVisible()
    expect(screen.getByRole('tablist')).toBeVisible()
  })

  it('a segmented control toggles Conversation | Report; the report is selected once it exists', async () => {
    viewport(1000)
    routes()
    renderApp()
    await openStored()
    const toggle = screen.getByRole('group', { name: 'Show' })
    const report = within(toggle).getByRole('button', { name: 'Report' })
    const conversation = within(toggle).getByRole('button', { name: 'Conversation' })
    expect(report).toHaveAttribute('aria-pressed', 'true')
    expect(conversation).toHaveAttribute('aria-pressed', 'false')
    // the report is on screen, the conversation (and its composer) is not
    expect(screen.getByRole('tablist')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Conversation' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Ask a follow-up question' })).toBeNull()

    fireEvent.click(conversation)
    expect(conversation).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('region', { name: 'Conversation' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Ask a follow-up question' })).toBeInTheDocument()
    expect(screen.queryByRole('tablist')).toBeNull()
    // the suggested tasks follow the composer
    expect(screen.queryByRole('group', { name: 'Suggested tasks' })).toBeNull()

    fireEvent.click(report)
    expect(screen.getByRole('tablist')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Suggested tasks' })).toBeNull()
  })

  it('"Use as follow-up" and a citation chip move to the pane they need', async () => {
    viewport(1000)
    routes()
    renderApp()
    await openStored()
    fireEvent.click(tab(/^Questions/))
    fireEvent.click(within(panel()).getByRole('button', { name: 'Use as follow-up: Question 1?' }))
    expect(screen.getByRole('button', { name: 'Conversation' })).toHaveAttribute('aria-pressed', 'true')
    expect(composer()).toHaveValue('Client answer to "Question 1?": ')
    // a chip in the conversation opens the Evidence tab and shows the report
    routes({ 'POST /api/sessions/s9/messages': () => ({ kind: 'answer', text: 'See the source.', cited_ids: ['S01-p10-nir-range'], tool_calls: [], proposed_facts: [] }) })
    fireEvent.change(composer(), { target: { value: 'Which source?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Show source S01 p.10' }))
    expect(screen.getByRole('button', { name: 'Report' })).toHaveAttribute('aria-pressed', 'true')
    expect(tab(/^Evidence/)).toHaveAttribute('aria-selected', 'true')
  })

  it('does not switch tabs with the number keys while the conversation is shown', async () => {
    viewport(1000)
    routes()
    renderApp()
    await openStored()
    fireEvent.click(screen.getByRole('button', { name: 'Conversation' }))
    fireEvent.keyDown(document.body, { key: '4' })
    fireEvent.click(screen.getByRole('button', { name: 'Report' }))
    expect(tab(/^Overview/)).toHaveAttribute('aria-selected', 'true')
  })
})

describe('print', () => {
  it('mounts the server document only while printing: no tab panels, no app chrome, then back to the active tab', async () => {
    const doc = {
      title: 'Dairy line fat content', version: 1, date: '2026-10-17', status: 'Provisional assessment', prepared_by: 'PRISM for AFS',
      front: [{ kind: 'h', text: 'Original enquiry', items: [], columns: [], rows: [], widths: [], level: 2, svg: '', title: '' }],
      sections: [{ id: 'recommendations', title: 'Recommendations', blocks: [{ kind: 'table', text: '', items: [], columns: ['Method', 'Status'], rows: [['NIR', 'Primary']], widths: [50, 50], level: 2, svg: '', title: '' }] }],
      legend: [],
    }
    routes({ '/api/runs/r7/report.doc': () => doc })
    renderApp()
    await openStored()
    expect(screen.queryByRole('article', { name: 'Print assessment report' })).toBeNull()
    await waitFor(() => expect(screen.getAllByRole('tabpanel')).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 30)) // the document is fetched ahead of the print dialog
    act(() => void window.dispatchEvent(new Event('beforeprint')))
    const article = screen.getByRole('article', { name: 'Print assessment report' })
    expect(within(article).getByRole('heading', { level: 2, name: 'Original enquiry' })).toBeInTheDocument()
    expect(within(article).getByRole('heading', { level: 2, name: '1 Recommendations' })).toBeInTheDocument()
    expect(within(article).getByRole('table')).toHaveTextContent('Primary')
    expect(screen.getByRole('tablist').closest('[data-print-hide]')).not.toBeNull()
    act(() => void window.dispatchEvent(new Event('afterprint')))
    expect(screen.queryByRole('article', { name: 'Print assessment report' })).toBeNull()
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
  })
})

describe('run states in the report pane', () => {
  it('a run in flight: skeleton header and tab bar, the live pipeline, then the report blurs in once', async () => {
    let done = false
    routeFetch({
      '/api/sessions': () => [],
      '/api/kb/spectral': () => mockSpectral,
      'POST /api/sessions': () => detail({ messages: [], reports: [] }),
      'POST /api/sessions/s9/runs': () => ({ run_id: 'r9' }),
      '/api/sessions/s9': () => detail(done ? { reports: [{ version: 1, run_id: 'r9' }] } : { reports: [] }),
      '/api/runs/r9/report': () => (done ? richReport('r9') : { status: 409, body: { detail: 'run is still running' } }),
    })
    renderApp()
    fireEvent.change(composer(), { target: { value: 'We want to monitor fat content in milk.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(FakeEventSource.for('/api/runs/r9/events')).toBeDefined())

    const pane = screen.getByRole('region', { name: 'Assessment report' })
    expect(pane).toHaveAttribute('aria-busy', 'true')
    expect(within(pane).queryByRole('tablist')).toBeNull()
    const live = within(pane).getByRole('region', { name: 'Run progress' })
    expect(within(live).getAllByRole('listitem')).toHaveLength(9)
    const es = FakeEventSource.for('/api/runs/r9/events')!
    act(() => {
      es.emit({ type: 'stage_started', stage: 'scope', seq: 0 }, 'r9')
      es.emit({ type: 'stage_completed', stage: 'scope', seq: 1, payload: { seconds: 0.2 } }, 'r9')
      es.emit({ type: 'stage_started', stage: 'rules', seq: 2 }, 'r9')
      es.emit({ type: 'rule_fired', stage: 'rules', seq: 3, payload: { rule_id: 'R-X', severity: 'info', message: 'm' } }, 'r9')
    })
    expect(within(live).getByText('0.2 s')).toBeInTheDocument()
    expect(within(live).getByText('1 rule')).toBeInTheDocument()

    done = true
    act(() => void es.emit({ type: 'run_completed', stage: 'render', seq: 4, payload: { status: 'PROVISIONAL' } }, 'r9'))
    await screen.findByRole('tablist', { name: 'Report sections' })
    // a fresh report reveals once: the header block and the Overview blocks blur in; other tabs do not animate on switch
    const pane2 = screen.getByRole('region', { name: 'Assessment report' })
    expect(pane2.querySelectorAll('.blur-in').length).toBeGreaterThanOrEqual(3)
    expect(pane2.querySelector('.reveal-word')).not.toBeNull()
    fireEvent.click(tab(/^Methods/))
    expect(panel().querySelector('.blur-in')).toBeNull()
    expect(panel().querySelector('.reveal-word')).toBeNull()
  })

  it('a stored report renders at once, without any reveal', async () => {
    routes()
    renderApp()
    await openStored()
    const pane = screen.getByRole('region', { name: 'Assessment report' })
    expect(pane.querySelector('.blur-in')).toBeNull()
    expect(pane.querySelector('.reveal-word')).toBeNull()
  })

  it('a refusal shows in the report pane with suggestions that fill the composer', async () => {
    routes({
      '/api/sessions': () => [detail({ id: 's5', title: 'Weather question' })],
      '/api/sessions/s5': () =>
        detail({
          id: 's5',
          title: 'Weather question',
          reports: [],
          messages: [
            { id: 'm1', session_id: 's5', role: 'user', kind: 'enquiry', text: 'What is the weather?', run_id: 'r5', created_at: '2026-10-17T09:00:00Z' },
            { id: 'm2', session_id: 's5', role: 'assistant', kind: 'refused', text: 'Refused.', run_id: 'r5', created_at: '2026-10-17T09:01:00Z' },
          ],
        }),
      '/api/runs/r5/report': () => ({
        status: 422,
        body: { refused: true, scope: { label: 'OFF_TOPIC', reason: 'Not a measurement task.', suggestions: ['Can a probe measure moisture in powder?'], tier: 'signals' }, markdown: '# Refused' },
      }),
    })
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Assessments' }))
    fireEvent.click(await screen.findByRole('button', { name: /Weather question/ }))
    expect(await screen.findByText('Not a measurement task.')).toBeInTheDocument()
    const pane = screen.getByRole('region', { name: 'Assessment report' })
    expect(within(pane).getByRole('heading', { name: /Outside PRISM's scope/ })).toBeInTheDocument()
    expect(within(pane).queryByRole('tablist')).toBeNull()
    fireEvent.click(within(pane).getByRole('button', { name: 'Can a probe measure moisture in powder?' }))
    expect(composer()).toHaveValue('Can a probe measure moisture in powder?')
  })

  it('a failed run shows the error in the report pane and Try again starts a new run', async () => {
    const { calls } = routeFetch({
      '/api/sessions': () => [],
      'POST /api/sessions': () => detail({ messages: [], reports: [] }),
      'POST /api/sessions/s9/runs': () => ({ run_id: 'r9' }),
      '/api/sessions/s9': () => detail({ reports: [] }),
      '/api/runs/r9/report': () => ({ status: 409, body: { detail: 'run is still running' } }),
    })
    renderApp()
    fireEvent.change(composer(), { target: { value: 'Enquiry text' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(FakeEventSource.for('/api/runs/r9/events')).toBeDefined())
    act(() => void FakeEventSource.for('/api/runs/r9/events')!.emit({ type: 'run_failed', stage: 'draft', seq: 0, payload: { error: 'Provider timed out' } }, 'r9'))
    const pane = screen.getByRole('region', { name: 'Assessment report' })
    expect(await within(pane).findByRole('alert')).toHaveTextContent('Provider timed out')
    fireEvent.click(within(pane).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(calls.filter((c) => c === 'POST /api/sessions/s9/runs')).toHaveLength(2))
  })
})

describe('conversation column', () => {
  it('shows the enquiry, one pipeline summary line, the follow-up turns and the task chips above the composer', async () => {
    routes()
    renderApp()
    await openStored()
    const conversation = screen.getByTestId('conversation')
    expect(within(conversation).getByText('We want to monitor fat content in milk.')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Suggested tasks' })).toBeNull()
    // and the report is not repeated in the conversation
    expect(within(conversation).queryByRole('heading', { name: 'Recommendations' })).toBeNull()
  })

  it('"Draft the customer e-mail" opens the draft; "Re-run in deep mode" starts a deep run and the pane shows its live view', async () => {
    const { fetchMock } = routes({ 'POST /api/sessions/s9/runs': () => ({ run_id: 'r10' }), '/api/sessions/s9/email-draft': () => ({ text: 'Dear customer' }) })
    renderApp()
    await openStored()
    fireEvent.click(screen.getByRole('button', { name: 'E-mail draft' }))
    fireEvent.keyDown(await screen.findByRole('dialog', { name: 'Customer e-mail draft' }), { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Re-run (deep)' }))
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s9/runs', expect.objectContaining({ method: 'POST', body: JSON.stringify({ deep: true, web: false }) })),
    )
    // the new run replaces the pane's content with its live view
    expect(await screen.findByRole('region', { name: 'Run progress' })).toBeInTheDocument()
  })

  it('a stored message that started a later version carries its "Report v2 ready" notice', async () => {
    routes({
      '/api/sessions/s9': () =>
        detail({
          reports: [{ version: 1, run_id: 'r6' }, { version: 2, run_id: 'r7' }],
          messages: [
            { id: 'm1', session_id: 's9', role: 'user', kind: 'enquiry', text: 'We want to monitor fat content in milk.', run_id: 'r6', created_at: '2026-10-17T09:00:00Z' },
            { id: 'm2', session_id: 's9', role: 'user', kind: 'new_client_info', text: 'The analyser is next to the line.', run_id: 'r7', created_at: '2026-10-17T09:05:00Z' },
          ],
        }),
      '/api/runs/r6/report': () => richReport('r6'),
    })
    renderApp()
    await openStored()
    const conversation = screen.getByTestId('conversation')
    expect(within(conversation).getByText('The analyser is next to the line.')).toBeInTheDocument()
    expect(within(conversation).getByText('Report v2 ready')).toBeInTheDocument()
    // v2 is the one on show: the notice says so; there is no notice for v1
    expect(within(conversation).getByText('Showing')).toBeInTheDocument()
    expect(within(conversation).queryByText('Report v1 ready')).toBeNull()
  })

  it('follows the newest content: a new answer scrolls the column to its end', async () => {
    const scrollTo = vi.fn()
    HTMLElement.prototype.scrollTo = scrollTo as never
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 2400 })
    try {
      routes({ 'POST /api/sessions/s9/messages': () => ({ kind: 'answer', text: 'An answer.', cited_ids: [], tool_calls: [], proposed_facts: [] }) })
      renderApp()
      await openStored()
      scrollTo.mockClear()
      fireEvent.change(composer(), { target: { value: 'A question' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await screen.findByText((_, el) => el?.tagName === 'P' && el.textContent === 'An answer.')
      await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 2400 })))
    } finally {
      delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight
    }
  })
})

describe('helpers', () => {
  it('converts a range to the other unit family, but not a Raman shift', () => {
    expect(alternateRange('NIR', '780–2500 nm')).toBe('12,821–4,000 cm⁻¹')
    expect(alternateRange('MIR', '2.5–25 µm')).toBe('4,000–400 cm⁻¹')
    expect(alternateRange('MIR', '4000–400 cm⁻¹')).toBe('2,500–25,000 nm')
    expect(alternateRange('Raman', '400–1100 nm')).toBeNull()
    expect(alternateRange('NIR', 'about 1 µm')).toBeNull()
  })

  it('labels a card by its page when the report does not list it', () => {
    expect(citationFromId('S01-p15-nir-raman-complementary')).toBe('S01 p.15')
    expect(citationFromId('TABLE-raman_raman_probe')).toBe('S01 Table 1')
    expect(citationFromId('EXT-08f39e27a1')).toBe('Web source')
    expect(citationFromId('mystery')).toBe('mystery')
  })

  it('shows an excitation wavelength only when the field holds one', () => {
    expect(excitationLabel('785')).toBe('785 nm')
    expect(excitationLabel(785)).toBe('785 nm')
    expect(excitationLabel('532 nm')).toBe('532 nm')
    expect(excitationLabel('{"decision_status": "PROVISIONAL"}')).toBeNull()
    expect(excitationLabel(null)).toBeNull()
  })

  it('reads a snake_case backend field as a sentence and leaves prose alone', () => {
    expect(plainText('calibration_invalid_or_signal_swamped')).toBe('Calibration invalid or signal swamped')
    expect(plainText('Method selection between Raman and NIR')).toBe('Method selection between Raman and NIR')
  })

  it('cuts the unknown groups after n unknowns', () => {
    const u = (slot: string): Unknown => ({ slot, why_it_matters: 'x', stream_id: null })
    const groups: [string, Unknown[]][] = [['a', [u('1'), u('2')]], ['b', [u('3'), u('4')]]]
    expect(firstUnknowns(groups, 3).map(([, items]) => items.length)).toEqual([2, 1])
    expect(firstUnknowns(groups, 1)).toEqual([['a', [u('1')]]])
  })

  it('builds the model: a primary recommendation, sorted questions, a pass tally and the chart methods from the rule engine', () => {
    const report = richReport('r1') as unknown as ReportViewData
    const model = buildReportModel(report, mockFindings as RuleFindings)
    expect(model.primary?.role).toBe('PRIMARY')
    expect(model.questions.map((q) => q.priority)).toEqual([1, 2, 3])
    expect(model.passed).toBe(2)
    expect(model.compliance).toHaveLength(3)
    expect(model.premiseProblems).toBe(1)
    expect(model.chartMethods).toEqual(['NIR', 'Raman', 'UV-Vis', 'MIR', 'Fluorescence'])
    expect(model.streamName('s1')).toBeNull() // a single stream is never named
  })
})
