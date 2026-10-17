// TypeScript mirror of backend/prism/schemas.py (JSON contract with the API).
// Keep field names identical to the Pydantic models.

export const CLAIM_TYPES = ['CLIENT', 'AFS', 'EXTERNAL', 'ASSUMPTION', 'PROPOSAL', 'UNKNOWN'] as const
export type ClaimType = (typeof CLAIM_TYPES)[number]

export const DECISION_STATUSES = ['PROVISIONAL', 'INSUFFICIENT_INFORMATION', 'OUTSIDE_SUPPORTED_SCOPE'] as const
export type DecisionStatus = (typeof DECISION_STATUSES)[number]

export type Verdict = 'YES' | 'NO' | 'NOT_YET' | 'CONDITIONAL' | 'NOT_APPLICABLE'
export type PremiseVerdict = 'SUPPORTED' | 'CONTRADICTED' | 'UNVERIFIABLE'
export type RecRole = 'PRIMARY' | 'COMPARISON' | 'CONDITIONAL' | 'SCREENING' | 'NOT_RECOMMENDED'
export type Scope =
  | 'method_general'
  | 'process_application'
  | 'lab_study'
  | 'in_vitro_poc'
  | 'business_context'
  | 'external'
export type Severity = 'info' | 'warning' | 'premise' | 'blocking' | 'gate'
export type ScopeLabel = 'IN_SCOPE' | 'PARTIAL' | 'OFF_TOPIC' | 'UNSAFE'

// ---------------------------------------------------------------- enquiry and requirements

export interface Segment {
  text: string
  claim_type: ClaimType
  evidence_ids: string[]
}

export interface Fact {
  value: string
  quote: string | null
}

export interface Target {
  name: string
  defined: boolean
  quote: string
}

export interface Stream {
  id: string
  name: string
  targets: Target[]
  matrix: Fact
  optics: Fact
}

export interface Interpretation {
  term: string
  canonical: string | null
  kind: 'method' | 'technique' | 'fiber' | 'matrix' | 'optics' | 'unit' | 'other'
  how: 'exact' | 'fuzzy' | 'embedding' | 'llm' | 'context'
  alternatives: string[]
  ambiguous: boolean
}

// ---------------------------------------------------------------- engine

export interface Finding {
  rule_id: string
  severity: Severity
  message: string
  evidence_ids: string[]
  stream_id: string | null
  blocks: string[]
  premise_index: number | null
  premise_verdict: PremiseVerdict | null
  status: DecisionStatus | null
  question: string | null
  question_impact: string | null
  slots_read: string[]
  data: Record<string, string>
}

export interface Candidate {
  key: string
  method: string
  technique: string
  technique_id: string
  stream_id: string
  fit: number
  optics: number
  evidence: number
  link: number
  blocked: boolean
  reasons: string[]
  evidence_ids: string[]
}

/** Mirrors the Python `Candidate.score` property (not serialised by the backend). */
export const candidateScore = (c: Candidate): number => c.fit + c.optics + c.evidence + c.link

export interface QuestionSeed {
  slot: string
  impact: 'STATUS_CHANGE' | 'PRIMARY_METHOD_CHANGE' | 'TECHNIQUE_CHANGE' | 'RISK_ONLY'
  outcomes: Record<string, string>
  rule_ids: string[]
  text_hint: string
}

export interface RuleFindings {
  findings: Finding[]
  candidates: Candidate[]
  question_seeds: QuestionSeed[]
  status: DecisionStatus
}

// ---------------------------------------------------------------- spectral windows (GET /api/kb/spectral)

/** A [low, high] range in µm. */
export type RangeUm = [number, number]

export interface SpectralMethod {
  id: string
  name: string
  range_um: RangeUm
  range_cm1: [number, number]
  cards: string[]
}

export interface SpectralFiber {
  id: string
  name: string
  range_um: RangeUm
  card: string
}

export interface SpectralInstrument {
  id: string
  name: string
  range_um: RangeUm
  card?: string
}

export interface SpectralData {
  methods: SpectralMethod[]
  fibers: SpectralFiber[]
  instruments: SpectralInstrument[]
}

export interface ScopeDecision {
  label: ScopeLabel
  reason: string
  suggestions: string[]
  tier: 'signals' | 'embeddings' | 'classifier'
}

// ---------------------------------------------------------------- report

export interface DirectAnswer {
  verdict: Verdict
  text: Segment[]
}

export interface PremiseCheck {
  premise: string
  verdict: PremiseVerdict
  explanation: Segment[]
}

export interface StatedFact {
  slot: string
  value: string
  quote: string
  stream_id: string | null
}

export interface Unknown {
  slot: string
  why_it_matters: string
  stream_id: string | null
}

export interface Requirements {
  stated_facts: StatedFact[]
  key_unknowns: Unknown[]
}

export interface Question {
  question: string
  priority: number
  decision_it_changes: string
  why_it_matters: string
}

export interface Recommendation {
  methods: string[]
  technique: string
  applies_to: string[]
  role: RecRole
  rationale: Segment[]
  conditions: Segment[]
  limitations: Segment[]
  evidence_strength: string | null
}

export interface MeasurementConcept {
  stream_id: string
  probe_geometry: string
  location: string
  fiber_link: string
  notes: Segment[]
}

export interface SpectralRange {
  method: string
  nominal_range: string
  units: string
  excitation_nm: string | null
  fiber_family_needed: string
  caveat: Segment[]
}

export interface Risk {
  risk: Segment[]
  effect: string
  mitigation: string
}

export interface Assumption {
  assumption: string
  to_confirm_with: string
}

export interface FeasibilityPlan {
  objective: string
  clarify_first: string[]
  samples_and_states: Segment[]
  reference_measurements: Segment[]
  setup: Segment[]
  comparison: Segment[]
  validation: Segment[]
  go_no_go: Segment[]
  not_demonstrated: Segment[]
  steps: string[]
}

export interface ReportBody {
  decision_status: DecisionStatus
  direct_answer: DirectAnswer
  premise_checks: PremiseCheck[]
  requirements: Requirements
  clarification_questions: Question[]
  recommendations: Recommendation[]
  measurement_concept: MeasurementConcept[]
  spectral_ranges: SpectralRange[]
  risks: Risk[]
  assumptions: Assumption[]
  feasibility_plan: FeasibilityPlan
  decision_basis: Segment[]
}

export interface SourceRef {
  id: string
  citation: string
  quote: string
  scope: Scope
  url: string | null
  doi?: string | null
  /** Present on verified web sources (scope `external`, ids `EXT-…`). */
  verification?: Verification | null
}

// ---------------------------------------------------------------- web search (backend prism/web, opt-in per run)

export type WebStatus = 'VERIFIED' | 'UNVERIFIED' | 'UNREACHABLE' | 'BLOCKED'
export type DomainTier = 'peer_reviewed' | 'standards' | 'vendor' | 'general'

/** Outcome of the deterministic checks on one web source and one quote. */
export interface Verification {
  status: WebStatus
  checks: Record<string, boolean>
  match_kind: 'exact' | 'fuzzy' | 'none'
  match_score: number
  domain: string
  domain_tier: DomainTier
  content_sha256: string
  retrieved_at: string
  url: string
  doi: string | null
  notes: string[]
}

/** One source a web run looked at: kept (`card_id` set) or rejected (`reason`). */
export interface WebSourceRecord {
  title: string
  url: string
  doi: string | null
  provider: string
  year: number | null
  verification: Verification | null
  card_id: string | null
  reason: string
}

/** `GET /api/runs/{id}/web-sources`. */
export interface WebSources {
  run_id: string
  enabled: boolean
  queries: string[]
  considered: number
  sources: WebSourceRecord[]
  cards: Card[]
}

/** Payload of the `web_source` SSE event (one per source considered). */
export interface WebSourceEvent {
  url: string
  title: string
  status: WebStatus | 'SKIPPED' | 'ERROR'
  domain: string
  card_id: string | null
  reason: string
}

export interface AssessmentReport extends ReportBody {
  case_id: string
  title: string
  input_sha256: string
  run_id: string
  created_at: string
  kb_version: string
  profile: string
  model_ids: Record<string, string>
  prompt_hashes: Record<string, string>
  client_question: string[]
  streams: Stream[]
  interpretations: Interpretation[]
  sources: SourceRef[]
  compliance: Record<string, boolean>
}

/** A verified web source cited by a chat answer (`ChatAnswer.web_sources`). */
export interface ChatWebSource {
  url: string
  title: string
  doi?: string | null
  domain: string
  domain_tier?: DomainTier
  retrieved_at?: string
  quote?: string
}

/** `GET /api/runs/{id}/report` (200): the report plus the run's rule findings and scope decision. */
export interface LiveReport extends AssessmentReport {
  findings?: RuleFindings | null
  scope?: ScopeDecision | null
}

/** `GET /api/runs/{id}/report` (422): the scope guard refused the enquiry. */
export interface RefusedReport {
  refused: true
  scope: ScopeDecision | null
  markdown: string
}

export type RunReport = LiveReport | RefusedReport

export const isRefusedReport = (r: RunReport | undefined): r is RefusedReport =>
  !!r && (r as RefusedReport).refused === true

export interface Card {
  id: string
  source: 'S01' | 'S02' | 'S03' | 'S04' | 'S05' | 'TABLE' | 'EXT'
  page: number
  quote: string
  claim: string
  scope: Scope
  methods: string[]
  topics: string[]
  status: 'draft' | 'seed' | 'accepted' | 'rejected' | 'web_verified'
  url: string | null
  retrieved_at: string | null
  reviewed_by: string | null
  doi?: string | null
  verification?: Verification | null
}

// ---------------------------------------------------------------- run events (SSE)

export const STAGES = [
  'scope',
  'extract',
  'normalise',
  'rules',
  'retrieve',
  'draft',
  'verify',
  'repair',
  'render',
] as const
/** Stages only some runs emit: the web search of a `web` run, between retrieve and draft. */
export const OPTIONAL_STAGES = ['web'] as const
export type Stage = (typeof STAGES)[number] | (typeof OPTIONAL_STAGES)[number]
/** Every stage a run can emit, in display order (`web` sits between retrieve and draft). */
export const ALL_STAGES: readonly Stage[] = [
  'scope',
  'extract',
  'normalise',
  'rules',
  'retrieve',
  'web',
  'draft',
  'verify',
  'repair',
  'render',
]

export type RunEventType =
  | 'stage_started'
  | 'stage_completed'
  | 'rule_fired'
  | 'evidence_selected'
  | 'web_source'
  | 'issue_found'
  | 'repaired'
  | 'run_completed'
  | 'run_refused'
  | 'run_failed'

/** Events after which the server closes the stream. */
export const TERMINAL_EVENTS: readonly RunEventType[] = ['run_completed', 'run_refused', 'run_failed']

/** SSE event shape: `{type, run_id, seq, ts, stage, payload}` (docs/ARCHITECTURE.md §8). */
export interface RunEvent<P = Record<string, unknown>> {
  type: RunEventType
  run_id: string
  seq: number
  /** Seconds since the epoch (Python `time.time()`). */
  ts: number
  stage: Stage | null
  payload: P
}

// ---------------------------------------------------------------- sessions and API envelopes

export interface Session {
  id: string
  title: string
  case_id: string | null
  created_at: string
}

export interface Health {
  status: string
  profile: string
  replay: boolean
  kb_hash: string
  budget?: Record<string, number>
  routing?: Record<string, string>
}

export interface RunStarted {
  run_id: string
}

export interface ChatMessage {
  id: string
  session_id: string
  role: 'user' | 'assistant'
  kind: 'enquiry' | 'new_client_info' | 'question' | 'instruction' | 'answer' | 'refused' | (string & {})
  text: string
  run_id: string | null
  created_at: string
}

/** One stored report version of a session (`GET /api/sessions/{id}`). */
export interface ReportVersion {
  version: number
  run_id: string
  created_at?: string
  decision_status?: DecisionStatus
}

export interface SessionDetail extends Session {
  messages: ChatMessage[]
  reports?: ReportVersion[]
}

export interface ToolCall {
  name: string
  arguments?: Record<string, unknown>
  result?: unknown
}

/** `POST /api/sessions/{id}/messages` response (docs/AI_ARCHITECTURE.md §5). */
export type ChatResponse =
  | { kind: 'run'; run_id: string }
  | {
      kind: 'answer'
      text: string
      cited_ids: string[]
      tool_calls: ToolCall[]
      proposed_facts: (string | { text: string })[]
      /** Verified web sources the answer cites (only when the agent used web search). */
      web_sources?: ChatWebSource[] | null
    }
  | { kind: 'refused'; reason: string; suggestions: string[] }

export interface Change<T> {
  from: T
  to: T
}

/** A recommendation as listed in a diff: keyed by methods + technique. */
export type DiffRecommendation =
  | string
  | { key?: string; methods?: string[]; technique?: string; role?: RecRole | string }

/** A recommendation whose role changed between versions. */
export type DiffRecommendationChange =
  | string
  | {
      key?: string
      methods?: string[]
      technique?: string
      from?: RecRole | string
      to?: RecRole | string
      /** Backend shape (`prism.chat.diff`). */
      from_role?: RecRole | string
      to_role?: RecRole | string
      role?: Change<RecRole | string>
    }

/** `GET /api/sessions/{id}/diff?from=&to=` response. */
export interface ReportDiff {
  status: Change<DecisionStatus> | null
  verdict: Change<Verdict> | null
  recommendations: { added: DiffRecommendation[]; removed: DiffRecommendation[]; changed: DiffRecommendationChange[] }
  questions: { resolved: (string | Question)[]; new: (string | Question)[] }
  risks: { added: (string | Risk)[]; removed: (string | Risk)[] }
}

export interface EmailDraft {
  text: string
}
