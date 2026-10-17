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

export interface Card {
  id: string
  source: 'S01' | 'S02' | 'S03' | 'S04' | 'S05' | 'TABLE' | 'EXT'
  page: number
  quote: string
  claim: string
  scope: Scope
  methods: string[]
  topics: string[]
  status: 'draft' | 'seed' | 'accepted' | 'rejected'
  url: string | null
  retrieved_at: string | null
  reviewed_by: string | null
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
export type Stage = (typeof STAGES)[number]

export type RunEventType =
  | 'stage_started'
  | 'stage_completed'
  | 'rule_fired'
  | 'evidence_selected'
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
  ts: string
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

export type SessionGroup = 'Dev' | 'Eval' | 'Mine'

export interface CaseInfo {
  case_id: string
  title: string
  kind: 'dev' | 'eval'
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
  kind: 'enquiry' | 'new_client_info' | 'question' | 'instruction' | 'answer'
  text: string
  run_id: string | null
  created_at: string
}
