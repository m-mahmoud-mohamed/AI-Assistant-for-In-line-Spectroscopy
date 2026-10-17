// Report exports: Markdown (server-rendered when a run exists, local fallback otherwise), JSON,
// print-to-PDF, and the offline e-mail draft. Local renderings only reformat report content.
import { api } from './api'
import { ROLE_LABEL, STATUS_LABEL, VERDICT_LABEL, labelOf } from './labels'
import type { ReportViewData } from './components/report/ReportView'
import type { Segment } from './types'

const CLAIM_TAG: Record<Segment['claim_type'], string> = {
  CLIENT: 'Client',
  AFS: 'AFS',
  EXTERNAL: 'External',
  ASSUMPTION: 'Assumption',
  PROPOSAL: 'Proposal',
  UNKNOWN: 'Unknown',
}

function segments(list: Segment[], cite: (id: string) => string): string {
  return list
    .map((s) => {
      const refs = s.evidence_ids.length ? ` (${s.evidence_ids.map(cite).join('; ')})` : ''
      return `[${CLAIM_TAG[s.claim_type]}] ${s.text}${refs}`
    })
    .join(' ')
}

/** Markdown rendering of a report, for offline export. Mirrors the sections of the report view. */
export function reportToMarkdown(report: ReportViewData): string {
  const citations = Object.fromEntries((report.sources ?? []).map((s) => [s.id, s.citation]))
  const cite = (id: string) => citations[id] ?? id
  const seg = (list: Segment[]) => segments(list, cite)
  const out: string[] = []
  const h = (title: string) => out.push('', `## ${title}`, '')

  out.push(`# ${report.title || 'PRISM assessment'}`, '')
  if (report.case_id) out.push(`**Case:** ${report.case_id}  `)
  out.push(`**Status:** ${labelOf(STATUS_LABEL, report.decision_status)}`)

  h('Direct answer')
  out.push(`**${labelOf(VERDICT_LABEL, report.direct_answer.verdict)}.** ${seg(report.direct_answer.text)}`)

  if (report.premise_checks.length) {
    h('Premise checks')
    for (const p of report.premise_checks) out.push(`- **${p.premise}** (${p.verdict.toLowerCase()}): ${seg(p.explanation)}`)
  }

  h('Requirements')
  for (const f of report.requirements.stated_facts) out.push(`- ${f.slot.replaceAll('_', ' ')}: ${f.value} — “${f.quote}”`)
  for (const u of report.requirements.key_unknowns) out.push(`- ${u.slot.replaceAll('_', ' ')}: unknown (${u.why_it_matters})`)
  if (!report.requirements.stated_facts.length && !report.requirements.key_unknowns.length) out.push('_None recorded._')

  h('Clarification questions')
  ;[...report.clarification_questions]
    .sort((a, b) => a.priority - b.priority)
    .forEach((q, i) => out.push(`${i + 1}. ${q.question} _Changes: ${q.decision_it_changes}. ${q.why_it_matters}_`))

  h('Recommendations')
  for (const r of report.recommendations) {
    out.push(`### ${r.methods.join(' + ')} · ${r.technique} (${labelOf(ROLE_LABEL, r.role)})`, '')
    if (r.rationale.length) out.push(seg(r.rationale), '')
    if (r.conditions.length) out.push(`**Conditions:** ${seg(r.conditions)}`, '')
    if (r.limitations.length) out.push(`**Limitations:** ${seg(r.limitations)}`, '')
  }

  h('Measurement concept')
  for (const m of report.measurement_concept) {
    out.push(`- **${m.stream_id}:** ${m.probe_geometry}; location: ${m.location}; fiber link: ${m.fiber_link}`)
    if (m.notes.length) out.push(`  ${seg(m.notes)}`)
  }

  if (report.spectral_ranges.length) {
    h('Spectral ranges')
    for (const s of report.spectral_ranges) {
      out.push(`- **${s.method}:** ${s.nominal_range} ${s.units}; fiber family: ${s.fiber_family_needed}${s.caveat.length ? `. ${seg(s.caveat)}` : ''}`)
    }
  }

  if (report.risks.length) {
    h('Risks')
    for (const r of report.risks) out.push(`- ${seg(r.risk)} Effect: ${r.effect}. Mitigation: ${r.mitigation}.`)
  }
  if (report.assumptions.length) {
    h('Assumptions')
    for (const a of report.assumptions) out.push(`- ${a.assumption} (confirm with ${a.to_confirm_with})`)
  }

  const plan = report.feasibility_plan
  h('Feasibility plan')
  out.push(`**Objective:** ${plan.objective}`, '')
  plan.steps.forEach((s, i) => out.push(`${i + 1}. ${s}`))
  out.push('', `**Go / no-go:** ${plan.go_no_go.length ? seg(plan.go_no_go) : 'to be agreed with client'}`)

  if (report.sources?.length) {
    h('Sources')
    for (const s of report.sources) out.push(`- **${s.citation}** (${s.scope}): “${s.quote}”${s.url ? ` ${s.url}` : ''}`)
  }
  return `${out.join('\n')}\n`
}

const fileStem = (report: ReportViewData) =>
  `prism-${(report.case_id || report.run_id || 'report').replace(/[^A-Za-z0-9_-]+/g, '-')}`

export function downloadText(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** Download the server-rendered Markdown for the run, or a local rendering when there is no run or no backend. */
export async function downloadMarkdown(report: ReportViewData, runId?: string | null) {
  let md: string | null = null
  if (runId) {
    try {
      md = await api.getReportMarkdown(runId)
    } catch {
      md = null
    }
  }
  downloadText(`${fileStem(report)}.md`, md ?? reportToMarkdown(report), 'text/markdown;charset=utf-8')
}

export function downloadJson(report: ReportViewData) {
  downloadText(`${fileStem(report)}.json`, `${JSON.stringify(report, null, 2)}\n`, 'application/json')
}

/** Browser print dialog; theme.css has the print stylesheet and ReportView prints every tab. */
export const printReport = () => window.print()

/** Offline e-mail draft: a polite request for the open clarification questions, nothing else. */
export function localEmailDraft(report: Pick<ReportViewData, 'clarification_questions'>): string {
  const questions = [...report.clarification_questions].sort((a, b) => a.priority - b.priority)
  return [
    'Dear [customer name],',
    '',
    'Thank you for your enquiry. To prepare a reliable assessment of your measurement task, we would be grateful for a few more details:',
    '',
    ...questions.map((q, i) => `${i + 1}. ${q.question}`),
    '',
    'Once we have this information, we will come back to you with a proposal for the next steps.',
    '',
    'Kind regards,',
    '[Your name]',
    'Art Fiber Systems',
    '',
  ].join('\n')
}
