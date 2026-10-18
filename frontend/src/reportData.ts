// A report as the API may deliver it: whole, or a section at a time. `completeReport` fills the sections that are not
// there yet with empty ones so that everything that reads a report (tabs, exports, suggestions) can rely on its shape.
import type { AssessmentReport, FeasibilityPlan, ReportBody, ReportViewData } from './types'

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

