// Development-only scripted backend for the assistant UI (`?demo=assistant`, guarded by `import.meta.env.DEV` in main.tsx,
// so none of this is in the production bundle). It stubs `fetch` and `EventSource` with a scripted CONTRACTS C4 turn
// (plan, tool activity, a question card, verdicts, the report run with C3 events, message, suggestions) and then types an
// enquiry into the real app, so the screenshots show the real components wired the real way.
//
//   ?demo=assistant                 the whole flow; the question card waits for a click
//   ?demo=assistant&scene=question  stops at the question card
//   ?demo=assistant&scene=done      answers the question itself and runs to the suggestions
//   add &fast=1 to shorten every pause
import report from '../test/fixtures/report.json'
import findings from '../test/fixtures/findings.json'
import spectral from '../test/fixtures/spectral.json'
import type { ClarifyQuestion, EnginePreview } from '../types'

const ENQUIRY =
  'We run a dairy line and want to monitor fat and protein in milk in-line. The analyzer would sit next to the pasteurizer, about 30 m from the control room. Is a probe-based method feasible?'
const SESSION = { id: 's1', title: 'Dairy line: fat and protein in milk', case_id: null, created_at: '2026-10-18T09:00:00Z' }

const params = new URLSearchParams(location.search)
const scene = params.get('scene') ?? 'flow'
const fast = params.get('fast') === '1'
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, fast ? Math.min(ms, 120) : ms))

// ---------------------------------------------------------------- scripted streams

type Json = Record<string, unknown>
class Stream {
  log: Json[] = []
  subs = new Set<DemoEventSource>()
  seq = 0
  push(event: Json) {
    const full = { seq: this.seq++, ts: Date.now() / 1000, ...event }
    this.log.push(full)
    for (const s of this.subs) s.deliver(full)
  }
}
const streams = new Map<string, Stream>()
const stream = (url: string) => {
  let s = streams.get(url)
  if (!s) streams.set(url, (s = new Stream()))
  return s
}

class DemoEventSource {
  readonly url: string
  readyState = 0
  onopen: ((e: Event) => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  constructor(url: string) {
    this.url = url
    const s = stream(url)
    setTimeout(() => {
      if (this.readyState === 2) return
      this.readyState = 1
      this.onopen?.(new Event('open'))
      for (const e of s.log) this.deliver(e)
      s.subs.add(this)
    }, 30)
  }
  deliver(event: Json) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(event) }))
  }
  addEventListener() {}
  removeEventListener() {}
  close() {
    this.readyState = 2
    stream(this.url).subs.delete(this)
  }
}

// ---------------------------------------------------------------- the story

const q = (id: string, slot: string, text: string, why: string, impact: ClarifyQuestion['impact'], options: [string, string, string][]): ClarifyQuestion => ({
  id,
  slot,
  stream_id: 's1',
  text,
  why,
  impact,
  options: options.map(([value, label, effect]) => ({ value, label, effect })),
})

const QUESTIONS: ClarifyQuestion[] = [
  q('optics', 'streams.s1.optics', 'What does the product look like optically?', 'It decides the probe geometry and which methods can see through it.', 'PRIMARY_METHOD_CHANGE', [
    ['clear', 'Clear liquid', 'transmission probe'],
    ['turbid', 'Turbid or opaque', 'diffuse reflection probe; Raman drops to comparison'],
    ['powder', 'Powder or solid', 'reflection probe'],
  ]),
  q('gmp', 'use_context', 'Is the result used for batch release (GMP)?', 'It sets how strict the validation plan has to be.', 'STATUS_CHANGE', [
    ['release', 'Yes, for release', 'stricter validation plan; status stays provisional'],
    ['monitoring', 'No, monitoring only', 'screening plan is enough'],
  ]),
]

const PREVIEW_1: EnginePreview = {
  status: 'INSUFFICIENT_INFORMATION',
  candidates: [
    { method: 'NIR', technique: 'transmission or transflection probe', score: 5, blocked: false },
    { method: 'Raman', technique: 'Raman probe', score: 5, blocked: false },
    { method: 'NIR', technique: 'diffuse reflection probe', score: 4, blocked: false },
    { method: 'MIR', technique: 'ATR probe', score: 2, blocked: true },
  ],
  questions: QUESTIONS,
  spectral_methods: ['NIR', 'Raman', 'MIR'],
}
const PREVIEW_2: EnginePreview = {
  status: 'PROVISIONAL',
  candidates: [
    { method: 'NIR', technique: 'diffuse reflection probe', score: 6, blocked: false },
    { method: 'Raman', technique: 'Raman probe', score: 4, blocked: false },
    { method: 'NIR', technique: 'transmission or transflection probe', score: 3, blocked: false },
    { method: 'MIR', technique: 'ATR probe', score: 2, blocked: true },
  ],
  questions: [],
  spectral_methods: ['NIR', 'Raman', 'MIR'],
}

const SOURCES = [
  { id: 'S01-p17-nir-reflection-opaque', citation: 'S01 p.17', quote: 'NIR reflection suits opaque or concentrated products.', scope: 'method_general', url: null },
  { id: 'S01-p10-nir-range', citation: 'S01 p.10', quote: 'NIR covers 780–2500 nm.', scope: 'method_general', url: null },
  { id: 'S02-p06-visnir-silica', citation: 'S02 p.6', quote: 'Silica fibers transmit VIS-NIR.', scope: 'lab_study', url: null },
]
const FULL_REPORT = {
  ...report,
  case_id: '',
  title: SESSION.title,
  run_id: 'r1',
  created_at: '2026-10-18T09:00:20Z',
  kb_version: 'kb-demo',
  profile: 'gemini',
  model_ids: { writer: 'demo-writer', judge: 'demo-judge' },
  client_question: ['Is a probe-based method feasible?'],
  sources: SOURCES,
  streams: [{ id: 's1', name: 'milk', targets: [], matrix: { value: 'milk', quote: null }, optics: { value: 'turbid', quote: null } }],
  compliance: { 'C-IDS': true, 'P-SCOPE': true, 'P-NO-NUMBERS': true, 'C-SUPPORT': true },
  findings: { ...findings, status: 'PROVISIONAL' },
  scope: { label: 'IN_SCOPE', reason: 'measurement enquiry', suggestions: [], tier: 'signals' },
}
const SECTION_FIELDS: Record<string, string[]> = {
  answer: ['direct_answer', 'premise_checks', 'recommendations', 'decision_status'],
  concept: ['measurement_concept', 'spectral_ranges', 'risks', 'assumptions'],
  plan: ['feasibility_plan', 'clarification_questions', 'decision_basis', 'requirements'],
}

const MESSAGE =
  '**Provisional: NIR with a diffuse reflection probe** is the best fit for a turbid, fat-rich product [S01-p17-nir-reflection-opaque].\n\nRaman stays a comparison method; the fiber link of about 30 m is no problem for silica in the NIR range [S01-p10-nir-range].\n\n- Check the product on a laboratory sample first.\n- Confirm the acceptance criteria with the client before the feasibility study.'

const plan = (statuses: string[], detail: Record<number, string> = {}) => ({
  steps: ['Understand the enquiry', 'Clarify open points', 'Write the assessment', 'Verify every sentence'].map((label, i) => ({
    id: `p${i}`,
    label,
    status: statuses[i],
    ...(detail[i] ? { detail: detail[i] } : {}),
  })),
})

let answered: (() => void) | null = null
let approved: ((yes: boolean) => void) | null = null
let runState: 'idle' | 'running' | 'completed' = 'idle'
const readySections: string[] = []
let turnCount = 0

async function runReport() {
  const R = stream('/api/runs/r1/events')
  const ev = (type: string, stage: string | null, payload: Json = {}) => R.push({ type, run_id: 'r1', stage, payload })
  runState = 'running'
  const stage = async (name: string, ms: number, payload?: () => void) => {
    ev('stage_started', name)
    await wait(ms)
    payload?.()
    ev('stage_completed', name, { seconds: Math.round(ms / 100) / 10 })
  }
  await stage('scope', 200)
  await stage('extract', 900)
  await stage('normalise', 150)
  await stage('rules', 300, () => {
    ev('rule_fired', 'rules', { rule_id: 'R-SAMPLE-GEOMETRY', severity: 'info', message: 'Turbid product: reflection geometry.' })
    ev('engine_ready', 'rules', { ...PREVIEW_2, questions: [] })
  })
  await stage('retrieve', 350, () => ev('evidence_selected', 'retrieve', { ids: SOURCES.map((s) => s.id) }))
  ev('stage_started', 'write')
  for (const section of ['answer', 'concept', 'plan']) {
    await wait(section === 'answer' ? 1300 : 800)
    readySections.push(section)
    ev('section_ready', 'write', { section, paths: SECTION_FIELDS[section] })
  }
  ev('stage_completed', 'write', { seconds: 3.1 })
  await stage('verify', 700)
  await stage('patch', 400)
  await stage('render', 100)
  runState = 'completed'
  ev('run_completed', 'render', { status: 'PROVISIONAL' })
}

async function turnOne() {
  const T = stream('/api/turns/t1/events')
  const ev = (type: string, payload: Json = {}) => T.push({ type, turn_id: 't1', payload })
  ev('plan', plan(['active', 'pending', 'pending', 'pending']))
  await wait(500)
  ev('tool_started', { call_id: 'c1', tool: 'assess.prepare', label: 'Reading the enquiry' })
  await wait(700)
  ev('tool_started', { call_id: 'c2', tool: 'kb.search', label: 'Searched AFS sources' })
  await wait(500)
  ev('tool_finished', { call_id: 'c2', tool: 'kb.search', summary: '12 cards', ms: 410, ok: true })
  await wait(700)
  ev('tool_finished', { call_id: 'c1', tool: 'assess.prepare', summary: '4 candidates, 1 blocked', ms: 2900, ok: true })
  ev('verdict', PREVIEW_1 as unknown as Json)
  ev('plan', plan(['done', 'active', 'pending', 'pending'], { 1: '2 questions change the recommendation' }))
  await wait(250)
  ev('question', { question_id: 'qq1', title: '2 questions that change the recommendation', questions: QUESTIONS })
  if (scene === 'question') return
  await new Promise<void>((resolve) => {
    answered = resolve
    if (scene === 'done') setTimeout(clickThroughQuestions, fast ? 100 : 1500)
  })
  ev('verdict', PREVIEW_2 as unknown as Json)
  ev('plan', plan(['done', 'done', 'active', 'pending']))
  await wait(300)
  ev('report', { run_id: 'r1', version: 1 })
  await runReport()
  ev('plan', plan(['done', 'done', 'done', 'done']))
  const words = MESSAGE.split(/(?<=\s)/)
  for (let i = 0; i < words.length; i += 3) {
    ev('message_delta', { text: words.slice(i, i + 3).join('') })
    await wait(35)
  }
  ev('suggestions', {
    options: [
      { label: 'Draft client e-mail', action: 'draft_email' },
      { label: 'Compare NIR vs Raman', action: 'compare', payload: { a: 'NIR', b: 'Raman' } },
      { label: 'Search literature', action: 'web.search' },
      { label: 'Re-run deep', action: 'assess.write_deep' },
    ],
  })
  ev('turn_completed', {
    message: MESSAGE,
    citations: { 'S01-p17-nir-reflection-opaque': 'S01 p.17', 'S01-p10-nir-range': 'S01 p.10' },
  })
}

async function turnFollowUp(id: string, action: string) {
  const T = stream(`/api/turns/${id}/events`)
  const ev = (type: string, payload: Json = {}) => T.push({ type, turn_id: id, payload })
  if (action === 'web.search') {
    ev('approval', {
      approval_id: 'ap1',
      action: 'web.search',
      label: 'Search scholarly literature for in-line NIR of milk fat?',
      why: 'The AFS sources cover milk only briefly. Verified external sources would add evidence for the primary method.',
      cost_calls: 3,
    })
    const yes = await new Promise<boolean>((resolve) => (approved = resolve))
    if (!yes) {
      ev('message_delta', { text: 'Skipped the literature search. The report stays based on the AFS sources.' })
      ev('turn_completed', { message: 'Skipped the literature search. The report stays based on the AFS sources.', citations: {} })
      return
    }
    ev('tool_started', { call_id: 'w1', tool: 'web.search', label: 'Searching scholarly sources' })
    await wait(1200)
    ev('tool_finished', { call_id: 'w1', tool: 'web.search', summary: '2 verified of 6', ms: 1180, ok: true })
  }
  const text = 'Done. This is a scripted demo turn; nothing was changed in the report.'
  ev('message_delta', { text })
  ev('turn_completed', { message: text, citations: {} })
}

// ---------------------------------------------------------------- fetch

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

async function route(method: string, url: string, body: Json | null): Promise<Response> {
  const path = url.replace(/\?.*$/, '')
  if (method === 'GET' && path === '/api/sessions') return json(created ? [SESSION] : [])
  if (method === 'GET' && path === '/api/kb/spectral') return json(spectral)
  if (method === 'POST' && path === '/api/sessions') {
    created = true
    return json(SESSION)
  }
  if (method === 'GET' && path === '/api/sessions/s1') {
    return json({
      ...SESSION,
      messages: [{ id: 'm1', session_id: 's1', role: 'user', kind: 'enquiry', text: ENQUIRY, run_id: null, created_at: SESSION.created_at }],
      reports: runState === 'completed' ? [{ version: 1, run_id: 'r1', created_at: '2026-10-18T09:00:20Z', decision_status: 'PROVISIONAL' }] : [],
    })
  }
  if (method === 'POST' && path === '/api/sessions/s1/turns') {
    const id = `t${++turnCount}`
    const action = typeof body?.action === 'string' ? body.action : ''
    void (turnCount === 1 ? turnOne() : turnFollowUp(id, action))
    return json({ turn_id: id })
  }
  if (method === 'POST' && /^\/api\/turns\/[^/]+\/answer$/.test(path)) {
    answered?.()
    return json({ ok: true })
  }
  if (method === 'POST' && /^\/api\/turns\/[^/]+\/approve$/.test(path)) {
    approved?.(body?.approved === true)
    return json({ ok: true })
  }
  if (method === 'POST' && /^\/api\/turns\/[^/]+\/stop$/.test(path)) return json({ ok: true })
  if (method === 'GET' && path === '/api/runs/r1/report') {
    if (runState === 'completed') return json(FULL_REPORT)
    if (readySections.length === 0) return json({ detail: 'run is still running' }, 409)
    // a backend that serves what is verified so far
    const have = new Set(readySections.flatMap((s) => SECTION_FIELDS[s]))
    return json({ ...Object.fromEntries(Object.entries(FULL_REPORT).filter(([k]) => have.has(k) || ['title', 'run_id', 'sources', 'streams', 'created_at'].includes(k))), findings: FULL_REPORT.findings })
  }
  return json({ detail: 'not found' }, 404)
}

let created = false

/** Pick "Turbid or opaque" and "No, monitoring only", then Apply: what a scientist would do (scene=done). */
function clickThroughQuestions() {
  const click = (name: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((el) => el.textContent?.includes(name))?.click()
  click('Turbid or opaque')
  click('No, monitoring only')
  setTimeout(() => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Apply answers')?.click(), 400)
}

/** Replace `fetch` and `EventSource` with the scripted backend, and type the enquiry into the home composer once the app is up. */
export function installAssistantDemo() {
  const realFetch = window.fetch.bind(window)
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname + input.search : input.url
    if (!url.startsWith('/api/')) return realFetch(input, init)
    let body: Json | null = null
    try {
      body = init?.body ? (JSON.parse(String(init.body)) as Json) : null
    } catch {
      body = null
    }
    return route(init?.method ?? 'GET', url, body)
  }) as typeof window.fetch
  ;(window as unknown as { EventSource: unknown }).EventSource = DemoEventSource

  const drive = (tries = 0) => {
    const ta = document.querySelector<HTMLTextAreaElement>('.composer textarea')
    const send = document.querySelector<HTMLButtonElement>('button[aria-label="Send"]')
    if (!ta || !send) {
      if (tries < 40) setTimeout(() => drive(tries + 1), 100)
      return
    }
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, ENQUIRY)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    setTimeout(() => document.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.click(), 150)
  }
  setTimeout(drive, 600)
}
