// What every report tab needs, derived once from the report and the rule engine's findings.
//
// The report may arrive in pieces (a section at a time): a section that is not in it yet is `pending`, and its tab shows a
// skeleton for it instead of nothing. `view` is the report with every absent section filled with an empty one, so the tabs
// are written against complete data and only consult `pending` to choose between content and skeleton.
import { citationFromId } from '../../labels'
import type { RunStatus } from '../../pipeline/reducer'
import { completeReport, type RawReport } from '../../reportData'
import type { Candidate, Question, Recommendation, ReportViewData, RuleFindings, SourceRef, StatedFact, Stream, Unknown } from '../../types'
import { sortedRecommendations } from '../report/recommendations'
import { citationCounts } from '../thread/sources'

/** The parts of a report a tab can wait for. */
export const SECTIONS = [
  'decision',
  'answer',
  'premises',
  'requirements',
  'questions',
  'recs',
  'concept',
  'ranges',
  'risks',
  'assumptions',
  'plan',
  'basis',
  'compliance',
  'sources',
  'candidates',
] as const
export type Section = (typeof SECTIONS)[number]
export type Pending = Record<Section, boolean>

/**
 * Which sections a tab should still wait for. A section the report always has is pending until the run ends (a finished
 * run that lacks one simply has none: "not in this report"); the ones a report may legitimately lack (compliance, sources,
 * the rule engine's candidates) are pending only while the run is in flight.
 */
export function pendingSections(raw: RawReport, rules: RuleFindings | undefined, status: RunStatus): Pending {
  const over = status === 'completed' || status === 'failed' || status === 'refused'
  const running = status === 'running'
  const body = (v: unknown) => v == null && !over
  const live = (v: unknown) => v == null && running
  return {
    decision: body(raw.decision_status),
    answer: body(raw.direct_answer),
    premises: body(raw.premise_checks),
    requirements: body(raw.requirements),
    questions: body(raw.clarification_questions),
    recs: body(raw.recommendations),
    concept: body(raw.measurement_concept),
    ranges: body(raw.spectral_ranges),
    risks: body(raw.risks),
    assumptions: body(raw.assumptions),
    plan: body(raw.feasibility_plan),
    basis: body(raw.decision_basis),
    compliance: live(raw.compliance),
    sources: live(raw.sources),
    candidates: !rules && running,
  }
}

export interface ReportModel {
  /** The report with absent sections filled empty: what the tabs read. */
  view: ReportViewData
  pending: Pending
  sources: SourceRef[]
  /** Card id → display citation (`S01 p.17`). */
  citations: Record<string, string>
  /** How many times each card is cited in the report. */
  counts: Record<string, number>
  streams: Stream[]
  /** A stream is named only when the enquiry has two or more. */
  multiStream: boolean
  streamName: (id: string | null) => string | null
  recs: Recommendation[]
  primary: Recommendation | undefined
  candidates: Candidate[]
  questions: Question[]
  facts: StatedFact[]
  unknowns: Unknown[]
  /** Unknowns that share a reason, grouped so the reason is shown once. */
  unknownGroups: [string, Unknown[]][]
  compliance: [string, boolean][]
  passed: number
  /** Premises that are not simply supported (they change the decision). */
  premiseProblems: number
  /** Candidate method ids for the spectral chart: the rule engine's candidates, else the recommended methods. */
  chartMethods: string[]
}

export function buildReportModel(raw: RawReport, rules?: RuleFindings, status: RunStatus = 'idle', spectralMethods: readonly string[] = []): ReportModel {
  const report = completeReport(raw)
  const sources = report.sources ?? []
  const streams = report.streams ?? []
  const names = Object.fromEntries(streams.map((s) => [s.id, s.name]))
  const multiStream = streams.length >= 2
  const recs = sortedRecommendations(report.recommendations)
  const unknowns = report.requirements.key_unknowns
  const by = new Map<string, Unknown[]>()
  for (const u of unknowns) by.set(u.why_it_matters, [...(by.get(u.why_it_matters) ?? []), u])
  const compliance = Object.entries(report.compliance ?? {})
  const candidates = rules?.candidates ?? []
  const citations: Record<string, string> = Object.fromEntries(sources.map((s) => [s.id, s.citation]))
  // cards the rule engine cites but the report text does not: still labelled as a page, never as a raw id
  for (const id of [...candidates.flatMap((c) => c.evidence_ids), ...(rules?.findings ?? []).flatMap((f) => f.evidence_ids)]) {
    if (!(id in citations)) citations[id] = citationFromId(id)
  }
  return {
    view: report,
    pending: pendingSections(raw, rules, status),
    sources,
    citations,
    counts: citationCounts(report),
    streams,
    multiStream,
    streamName: (id) => (multiStream && id ? (names[id] ?? id) : null),
    recs,
    primary: recs.find((r) => r.role === 'PRIMARY') ?? recs[0],
    candidates,
    questions: [...report.clarification_questions].sort((a, b) => a.priority - b.priority),
    facts: report.requirements.stated_facts,
    unknowns,
    unknownGroups: [...by.entries()],
    compliance,
    passed: compliance.filter(([, ok]) => ok).length,
    premiseProblems: report.premise_checks.filter((p) => p.verdict !== 'SUPPORTED').length,
    chartMethods: [
      ...new Set(spectralMethods.length ? spectralMethods : candidates.length ? candidates.map((c) => c.method) : report.recommendations.flatMap((r) => r.methods)),
    ],
  }
}

/** The groups cut after `n` unknowns in total (the Overview's top few). */
export function firstUnknowns(groups: [string, Unknown[]][], n: number): [string, Unknown[]][] {
  const out: [string, Unknown[]][] = []
  let left = n
  for (const [why, items] of groups) {
    if (left <= 0) break
    out.push([why, items.slice(0, left)])
    left -= items.length
  }
  return out
}
