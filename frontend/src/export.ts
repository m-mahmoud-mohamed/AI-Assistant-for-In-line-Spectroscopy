// Report exports. The server builds the documents (PDF, Markdown, JSON and the print view) from one model, for the
// version the run holds, so every export says which version it is. A local rendering only stands in when there is no
// run or no server; it follows the same order and the same content rules.
import { api, reportFileUrl, type AppendixOptions } from './api'
import { ROLE_LABEL, STATUS_LABEL, VERDICT_LABEL, labelOf, plainText, slotLabel } from './labels'
import type { ReportViewData, Segment } from './types'

export interface ExportOptions {
  /** Add the conversation as a separate appendix (off by default). */
  includeConversation?: boolean
  /** Add the technical appendix: checks, run id, models, knowledge-base version (off by default). */
  includeTechnical?: boolean
}

const appendix = (o: ExportOptions = {}): AppendixOptions => ({ conversation: o.includeConversation, technical: o.includeTechnical })

const MARKS: Partial<Record<Segment['claim_type'], string>> = { EXTERNAL: '†', ASSUMPTION: '*', UNKNOWN: '‡' }
const MARK_TEXT: Record<string, string> = { '†': 'external (web) source', '*': 'assumption to be confirmed', '‡': 'not known, an open point' }

/** Markdown rendering of the report for offline use: the same order and rules as the server's export. */
export function reportToMarkdown(report: ReportViewData, options: ExportOptions = {}): string {
  const refs = Object.fromEntries((report.sources ?? []).map((s, i) => [s.id, i + 1]))
  const used = new Set<string>()
  const seg = (list: Segment[]) =>
    list
      .map((s) => {
        const nums = [...new Set(s.evidence_ids.map((id) => refs[id]).filter(Boolean))].sort((a, b) => a - b)
        const mark = MARKS[s.claim_type] ?? ''
        if (mark) used.add(mark)
        return `${s.text}${nums.length ? ` [${nums.join(', ')}]` : ''}${mark}`
      })
      .join(' ')
  const info = report.version_info
  const version = info?.version ?? 1
  const out: string[] = []
  const h = (title: string) => out.push('', `## ${title}`, '')
  let n = 0
  const section = (title: string) => h(`${++n}. ${title}`)

  out.push(`# ${report.title || 'PRISM assessment'}`, '')
  out.push([report.created_at?.slice(0, 10), `Report v${version}`, labelOf(STATUS_LABEL, report.decision_status), 'PRISM for Art Fiber Systems (AFS)'].filter(Boolean).join(' · '))
  if (info?.session_id) out.push('', `_Session ${info.session_id}${report.profile ? ` · profile ${report.profile}` : ''}_`)
  out.push('', '### Original enquiry', '', ...(report.original_enquiry ? report.original_enquiry.split('\n').map((l) => `> ${l}`) : ['_The original enquiry is not stored with this report._']))
  if (report.client_question?.length) out.push('', '### Client question', '', report.client_question.join(' '))
  out.push('', '### Direct answer', '', `**${labelOf(VERDICT_LABEL, report.direct_answer.verdict)}.** ${seg(report.direct_answer.text)}`)

  if (report.recommendations.length) {
    section('Recommendations')
    for (const r of report.recommendations) {
      out.push(`**${r.methods.join(' + ')} · ${r.technique}**`, '', `_${labelOf(ROLE_LABEL, r.role)} · evidence ${r.evidence_strength ?? 'not rated'}_`, '')
      if (r.rationale.length) out.push(seg(r.rationale), '')
      if (r.conditions.length) out.push(`**Conditions.** ${seg(r.conditions)}`, '')
      if (r.limitations.length) out.push(`**Limitations.** ${seg(r.limitations)}`, '')
    }
  }
  if (report.spectral_ranges.length) {
    section('Spectral ranges and fibers')
    out.push('| Method | Nominal range | Fiber |', '| --- | --- | --- |')
    for (const s of report.spectral_ranges) out.push(`| ${s.method} | ${s.nominal_range} | ${s.fiber_family_needed} |`)
  }
  if (report.measurement_concept.length) {
    section('Measurement concept')
    for (const m of report.measurement_concept) {
      out.push(`- ${m.probe_geometry}; location: ${m.location}; fiber link: ${m.fiber_link}`)
      if (m.notes.length) out.push(`  ${seg(m.notes)}`)
    }
  }
  if (report.risks.length || report.assumptions.length) {
    section('Risks and assumptions')
    for (const r of report.risks) out.push(`- ${seg(r.risk)} Effect: ${plainText(r.effect).replace(/\.$/, '')}. Mitigation: ${plainText(r.mitigation).replace(/\.$/, '')}.`)
    for (const a of report.assumptions) out.push(`- Assumption: ${a.assumption} (to confirm with ${a.to_confirm_with})`)
  }
  const plan = report.feasibility_plan
  if (plan.steps.length || plan.objective) {
    section('Feasibility plan')
    out.push(`**Objective.** ${plan.objective}`, '')
    plan.steps.forEach((s, i) => out.push(`${i + 1}. ${s}`))
    for (const [label, list] of [
      ['Samples and states', plan.samples_and_states], ['Reference measurements', plan.reference_measurements],
      ['Set-up', plan.setup], ['Comparison', plan.comparison], ['Validation', plan.validation],
      ['Go / no-go', plan.go_no_go], ['Not demonstrated', plan.not_demonstrated],
    ] as const) if (list.length) out.push('', `**${label}.** ${seg(list)}`)
  }
  const questions = [...report.clarification_questions].sort((a, b) => a.priority - b.priority)
  if (questions.length) {
    section('Open questions for the client')
    questions.forEach((q, i) => out.push(`${i + 1}. ${q.question}${q.why_it_matters ? ` Why it matters: ${q.why_it_matters}` : ''}`))
  }
  const { stated_facts: facts, key_unknowns: unknowns } = report.requirements
  if (facts.length || unknowns.length) {
    section('What the client told us and what is still unknown')
    if (facts.length) {
      out.push('| Topic | Value | Client\'s words |', '| --- | --- | --- |')
      for (const f of facts) out.push(`| ${slotLabel(f.slot)} | ${plainText(f.value)} | ${f.provenance === 'confirmed' ? 'Confirmed by the scientist in conversation' : `“${f.quote}”`} |`)
    }
    if (unknowns.length) out.push('', '**Still unknown**', '', ...unknowns.map((u) => `- ${slotLabel(u.slot)}: ${u.why_it_matters}`))
  }
  if (version > 1 || info?.trigger) {
    section('Changes in this version')
    if (info?.summary) out.push(info.summary, '')
    if (info?.trigger) out.push(`**Follow-up that led to this version.** “${info.trigger}”`, '')
    if (info?.follow_up_findings.length) out.push('**New information recorded.**', '', ...info.follow_up_findings.map((f) => `- ${f}`))
  }
  if (report.sources?.length) {
    h('References')
    report.sources.forEach((s, i) => out.push(`${i + 1}. ${s.citation}: “${s.quote}”${s.url ? ` ${s.url}` : ''}`))
  }
  if (used.size) out.push('', '---', `Markers: ${[...used].map((m) => `${m} ${MARK_TEXT[m]}`).join('; ')}.`)
  if (options.includeConversation || options.includeTechnical) {
    out.push('', '_The appendices (conversation, technical details) are added by the server export._')
  }
  return `${out.join('\n')}\n`
}

/** `prism-<case>-v2.md`: the file name carries the version it holds. */
const fileStem = (report: ReportViewData) =>
  `prism-${(report.case_id || report.run_id || 'report').replace(/[^A-Za-z0-9_-]+/g, '-')}-v${report.version_info?.version ?? 1}`

export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export const downloadText = (filename: string, text: string, type: string) => downloadBlob(filename, new Blob([text], { type }))

/** The server's file for a run, or null when it cannot be had (no run, no server, a refused enquiry). */
async function fetchExport(runId: string | null | undefined, ext: 'json' | 'pdf', options: ExportOptions): Promise<Blob | null> {
  if (!runId) return null
  try {
    const res = await fetch(reportFileUrl(runId, ext, appendix(options)))
    return res.ok ? await res.blob() : null
  } catch {
    return null
  }
}

/** The Markdown of the version the run holds, from the server; the local rendering when there is no run or no backend. */
export async function downloadMarkdown(report: ReportViewData, runId?: string | null, options: ExportOptions = {}) {
  let md: string | null = null
  if (runId) {
    try {
      md = await api.getReportMarkdown(runId, appendix(options))
    } catch {
      md = null
    }
  }
  downloadText(`${fileStem(report)}.md`, md ?? reportToMarkdown(report, options), 'text/markdown;charset=utf-8')
}

export async function downloadJson(report: ReportViewData, runId?: string | null, options: ExportOptions = {}) {
  const served = await fetchExport(runId, 'json', options)
  downloadBlob(`${fileStem(report)}.json`, served ?? new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: 'application/json' }))
}

/** The A4 PDF built by the server. Resolves false when it cannot be had (the caller then offers the browser print). */
export async function downloadPdf(report: ReportViewData, runId?: string | null, options: ExportOptions = {}): Promise<boolean> {
  const served = await fetchExport(runId, 'pdf', options)
  if (!served) return false
  downloadBlob(`${fileStem(report)}.pdf`, served)
  return true
}

/** The browser's print dialog: the report pane prints its own print-only document (A4, light colours, no app chrome). */
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
