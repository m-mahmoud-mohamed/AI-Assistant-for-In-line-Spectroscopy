// A report as the API may deliver it: whole, or a section at a time. `completeReport` fills the sections that are not
// there yet with empty ones so that everything that reads a report (tabs, exports, suggestions) can rely on its shape.
import { IMPACT_NOTE } from './assistant/format'
import type { AssessmentReport, EnginePreview, FeasibilityPlan, ReportBody, ReportViewData, RuleFindings } from './types'

/** A report that may lack sections (it is still being written, or an older run stored fewer of them). */
export type RawReport = Partial<ReportBody> & Partial<Omit<AssessmentReport, keyof ReportBody>>

const EMPTY_PLAN: FeasibilityPlan = {
  objective: '',
  clarify_first: [],
  samples_and_states: [],
  reference_measurements: [],
  setup: [],
  comparison: [],
  validation: [],
  go_no_go: [],
  not_demonstrated: [],
  steps: [],
}

/** The report with every absent section replaced by an empty one (see `pending` for which ones were absent). */
export function completeReport(raw: RawReport): ReportViewData {
  return {
    ...raw,
    decision_status: raw.decision_status ?? 'INSUFFICIENT_INFORMATION',
    direct_answer: raw.direct_answer ?? { verdict: 'NOT_APPLICABLE', text: [] },
    premise_checks: raw.premise_checks ?? [],
    requirements: raw.requirements ?? { stated_facts: [], key_unknowns: [] },
    clarification_questions: raw.clarification_questions ?? [],
    recommendations: raw.recommendations ?? [],
    measurement_concept: raw.measurement_concept ?? [],
    spectral_ranges: raw.spectral_ranges ?? [],
    risks: raw.risks ?? [],
    assumptions: raw.assumptions ?? [],
    feasibility_plan: raw.feasibility_plan ?? EMPTY_PLAN,
    decision_basis: raw.decision_basis ?? [],
  }
}


// ---------------------------------------------------------------- the engine's result as an early, partial report

/**
 * What the report can already say when the engine has run but no writer has: the decision status and the ranked
 * questions. Every other section is absent, so the workspace shows its skeleton there.
 */
export function provisionalReport(engine: EnginePreview): RawReport {
  return {
    decision_status: engine.status,
    clarification_questions: engine.questions.map((q, i) => ({
      question: q.text,
      priority: i + 1,
      decision_it_changes: IMPACT_NOTE[q.impact] ?? '',
      why_it_matters: q.why,
    })),
  }
}

/** The engine's candidates as rule findings: the Spectral tab draws their methods; the score breakdown arrives with the report. */
export function previewFindings(engine: EnginePreview): RuleFindings {
  return {
    status: engine.status,
    findings: [],
    question_seeds: [],
    candidates: engine.candidates.map((c) => ({
      key: `${c.method}|${c.technique}`,
      method: c.method,
      technique: c.technique,
      technique_id: '',
      stream_id: '',
      fit: c.score,
      optics: 0,
      evidence: 0,
      link: 0,
      blocked: c.blocked,
      reasons: [],
      evidence_ids: [],
    })),
  }
}
