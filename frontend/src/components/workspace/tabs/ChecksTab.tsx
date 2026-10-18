import { CircleCheck, CircleX } from 'lucide-react'
import { checkLabel, ruleLabel } from '../../../labels'
import type { Finding, Severity } from '../../../types'
import { DisclosureRow } from '../../report/Disclosure'
import { TabSection } from '../TabSection'
import type { TabProps } from './types'

const SECTION: Record<string, string> = {
  direct_answer: 'Direct answer', premise_checks: 'Premise checks', recommendations: 'Recommendations',
  measurement_concept: 'Measurement concept', spectral_ranges: 'Spectral ranges', risks: 'Risks',
  assumptions: 'Assumptions', feasibility_plan: 'Feasibility plan', decision_basis: 'Decision basis',
  clarification_questions: 'Questions',
}
/** The report section a judged claim sits in, in plain words (never the internal field path). */
const sectionOf = (path: string) => SECTION[path.split(/[.[]/)[0]] ?? 'Report'

const SEVERITY: Record<Severity, { label: string; tone: 'bad' | 'warn' | 'info' | 'neutral' }> = {
  blocking: { label: 'Blocking', tone: 'bad' },
  gate: { label: 'Gate', tone: 'warn' },
  premise: { label: 'Premise', tone: 'warn' },
  warning: { label: 'Warning', tone: 'warn' },
  info: { label: 'Info', tone: 'neutral' },
}

/** Format and policy checks, evidence support and the rule engine's findings. */
export function ChecksTab({ assessment: a, report, rules, model }: TabProps) {
  const { pending } = model
  const findings: Finding[] = rules?.findings ?? []
  const blocking = findings.filter((f) => f.severity === 'blocking').length
  const formatChecks = model.compliance.filter(([id]) => id !== 'C-SUPPORT')
  const failed = formatChecks.filter(([, ok]) => !ok)
  const checks = [...failed, ...formatChecks.filter(([, ok]) => ok)]
  return (
    <div className="tab-stack">
      <TabSection
        title="Format and policy checks"
        pending={pending.compliance}
        rows={4}
        aside={
          <span className={`pill pill-${failed.length ? 'bad' : 'ok'} tabular`}>
            {formatChecks.length - failed.length}/{formatChecks.length} passed
          </span>
        }
      >
        <p className="rs-muted">These checks cover report structure, citation identifiers, numbers and policy rules. Passing them does not establish scientific correctness.</p>
        {checks.length > 0 ? (
          <ul className="ck-grid">
            {checks.map(([id, ok]) => (
              <li key={id} data-ok={ok ? 'true' : 'false'}>
                {ok ? <CircleCheck size={16} aria-hidden="true" style={{ color: 'var(--status-ok)' }} /> : <CircleX size={16} aria-hidden="true" style={{ color: 'var(--status-bad)' }} />}
                <span className="sr-only">{ok ? 'Pass: ' : 'Fail: '}</span>
                <span>{checkLabel(id)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rs-muted">No compliance checks are stored with this report.</p>
        )}
      </TabSection>

      <TabSection title="Evidence support of claims">
        <p className="rs-muted">The support judge compares source-based claims with their cited passages. A supported claim can still depend on scope and experimental validation; it is not a guarantee of scientific correctness.</p>
        {report.claim_verification?.verdicts.length ? (
          <p className="rs-p">
            Structural checks {failed.length ? `failed: ${failed.length}` : 'passed'}. Evidence support:{' '}
            {report.claim_verification.verdicts.filter((v) => v.verdict === 'supported').length} supported,{' '}
            {report.claim_verification.verdicts.filter((v) => v.verdict === 'partial').length} partial,{' '}
            {report.claim_verification.verdicts.filter((v) => v.verdict !== 'supported' && v.verdict !== 'partial').length} not supported.
          </p>
        ) : null}
        {report.claim_verification?.verdicts.length ? (
          <ul>{report.claim_verification.verdicts.map((v, i) => <li key={i}><strong>{v.verdict}</strong>: {v.reason || 'Compared with the cited passage.'}<span className="ck-path"> · {sectionOf(v.path)}</span></li>)}</ul>
        ) : <p className="rs-muted">{report.claim_verification ? 'No additional judge verdicts were recorded. Verbatim card claims are supported by construction; proposals and assumptions are not evidence claims.' : 'Claim-level judge results were not stored for this version.'}</p>}
        {report.claim_verification?.issues.filter((i) => i.check_id === 'C-SUPPORT').map((i, n) => <p key={n}>{i.message}</p>)}
      </TabSection>

      {pending.candidates && <TabSection title="Rule engine findings" pending rows={2}>{null}</TabSection>}
      {findings.length > 0 && (
        <section aria-label="Rule engine findings" className="rs-sec" data-row="true">
          <DisclosureRow
            id="ck-rules"
            label="Rule engine findings"
            summary={`${findings.length} ${findings.length === 1 ? 'finding' : 'findings'}${blocking ? ` · ${blocking} blocking` : ''}`}
          >
            <div className="tbl-wrap">
              <table aria-label="Rule engine findings" className="tbl">
                <thead>
                  <tr>
                    <th scope="col">Severity</th>
                    <th scope="col">Rule</th>
                    <th scope="col">Finding</th>
                  </tr>
                </thead>
                <tbody>
                  {findings.map((f, i) => {
                    const sev = SEVERITY[f.severity] ?? SEVERITY.info
                    return (
                      <tr key={i}>
                        <td>
                          <span className={`pill pill-${sev.tone}`}>{sev.label}</span>
                        </td>
                        <th scope="row" className="hm-method">
                          {ruleLabel(f.rule_id)}
                        </th>
                        <td>
                          {f.message}
                          {f.evidence_ids.length > 0 && (
                            <span className="ck-cites">
                              {f.evidence_ids.map((id) => (
                                <button key={id} type="button" className="cite-sup" aria-label={`Show source ${model.citations[id] ?? id}`} onClick={() => a.cite(id)}>
                                  {model.citations[id] ?? id}
                                </button>
                              ))}
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </DisclosureRow>
        </section>
      )}

    </div>
  )
}
