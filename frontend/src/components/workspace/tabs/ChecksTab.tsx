import { Fragment } from 'react'
import { CircleCheck, CircleX, Network } from 'lucide-react'
import { checkLabel, ruleLabel } from '../../../labels'
import { STAGE_LABELS } from '../../../pipeline/reducer'
import { formatSeconds, NODE_STATUS, stageCounts, stagesRun, totalSeconds } from '../../../pipeline/status'
import { formatSessionDate } from '../../../sessions'
import { ALL_STAGES, type Finding, type Severity } from '../../../types'
import { DisclosureRow } from '../../report/Disclosure'
import { TabSection } from '../TabSection'
import type { TabProps } from './types'

const SEVERITY: Record<Severity, { label: string; tone: 'bad' | 'warn' | 'info' | 'neutral' }> = {
  blocking: { label: 'Blocking', tone: 'bad' },
  gate: { label: 'Gate', tone: 'warn' },
  premise: { label: 'Premise', tone: 'warn' },
  warning: { label: 'Warning', tone: 'warn' },
  info: { label: 'Info', tone: 'neutral' },
}

const STAGE_TONE = { done: 'ok', warning: 'warn', failed: 'bad', refused: 'bad', running: 'info', idle: 'neutral' } as const

/** Whether the report can be trusted and how it was made: compliance checks, verifier and rule findings, the pipeline trace with timings, and the run's metadata. */
export function ChecksTab({ assessment: a, report, rules, model }: TabProps) {
  const state = a.run.state
  const { pending } = model
  const total = totalSeconds(state)
  const stages = stagesRun(state)
  const issues = ALL_STAGES.flatMap((s) => state.stages[s].issues.map((issue) => ({ ...issue, stage: s })))
  const repaired = state.stages.patch.repaired + state.stages.repair.repaired
  const findings: Finding[] = rules?.findings ?? []
  const blocking = findings.filter((f) => f.severity === 'blocking').length
  const failed = model.compliance.filter(([, ok]) => !ok)
  const checks = [...failed, ...model.compliance.filter(([, ok]) => ok)]
  const ranStage = (s: (typeof ALL_STAGES)[number]) => state.stages[s].status !== 'idle'

  const meta: [string, string | undefined][] = [
    ['Run', report.run_id],
    ['Case', report.case_id || undefined],
    ['Created', report.created_at ? formatSessionDate(report.created_at) : undefined],
    ['Profile', report.profile],
    ['KB version', report.kb_version],
    ['Web search', state.status === 'idle' ? undefined : ranStage('web') ? 'yes' : 'no'],
    ['Input SHA-256', report.input_sha256],
    ...Object.entries(report.model_ids ?? {}).map(([role, model]): [string, string] => [`Model · ${role}`, model]),
    ...Object.entries(report.prompt_hashes ?? {}).map(([name, hash]): [string, string] => [`Prompt · ${name}`, hash]),
  ]

  return (
    <div className="tab-stack">
      <TabSection
        title="Compliance checks"
        pending={pending.compliance}
        rows={4}
        aside={
          <span className={`pill pill-${failed.length ? 'bad' : 'ok'} tabular`}>
            {model.passed}/{model.compliance.length} passed
          </span>
        }
      >
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

      <TabSection title="Verifier findings" aside={repaired > 0 ? <span className="rs-muted-note">{repaired} repaired</span> : undefined}>
        {issues.length > 0 ? (
          <div className="tbl-wrap">
            <table aria-label="Verifier findings" className="tbl">
              <thead>
                <tr>
                  <th scope="col">Check</th>
                  <th scope="col">Severity</th>
                  <th scope="col">Finding</th>
                </tr>
              </thead>
              <tbody>
                {issues.map((i, k) => (
                  <tr key={k}>
                    <th scope="row" className="hm-method">
                      {checkLabel(i.check_id)}
                    </th>
                    <td>
                      <span className={`pill pill-${i.severity === 'error' ? 'bad' : 'warn'}`}>{i.severity}</span>
                    </td>
                    <td>
                      {i.message}
                      {i.path && <span className="ck-path mono">{i.path}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="rs-muted">{state.status === 'idle' ? 'The run trace is not available.' : 'The verifier raised no issues.'}</p>
        )}
      </TabSection>

      <TabSection
        title="Pipeline trace"
        aside={
          <button type="button" className="link-btn ts-link" onClick={a.showGraph} data-print-hide>
            <Network size={14} strokeWidth={1.75} aria-hidden="true" />
            View graph
          </button>
        }
      >
        {state.status === 'idle' ? (
          <p className="rs-muted">The run trace is not available.</p>
        ) : (
          <div className="tbl-wrap">
            <table aria-label="Pipeline trace" className="tbl">
              <thead>
                <tr>
                  <th scope="col">Stage</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">
                    Time
                  </th>
                  <th scope="col" aria-label="Share of the run">
                    Share
                  </th>
                  <th scope="col">Findings</th>
                </tr>
              </thead>
              <tbody>
                {stages.map((stage) => {
                  const st = state.stages[stage]
                  const share = total && st.seconds !== null ? st.seconds / total : 0
                  return (
                    <tr key={stage}>
                      <th scope="row" className="hm-method">
                        <button
                          type="button"
                          className="link-btn pt-stage"
                          aria-label={`Open ${STAGE_LABELS[stage]} stage details`}
                          onClick={() => {
                            a.setSelectedStage(stage)
                            a.setGraphOpen(true)
                          }}
                        >
                          {STAGE_LABELS[stage]}
                        </button>
                      </th>
                      <td>
                        <span className={`pill pill-${STAGE_TONE[st.status]}`}>{NODE_STATUS[st.status].label}</span>
                      </td>
                      <td className="num tabular">{formatSeconds(st.seconds) ?? '—'}</td>
                      <td className="pt-share" aria-hidden="true">
                        <span className="pt-track">
                          <span className="pt-bar" style={{ width: `${Math.max(share > 0 ? 2 : 0, Math.round(share * 100))}%` }} />
                        </span>
                      </td>
                      <td className="rs-muted-inline">{stageCounts(st).join(', ') || '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
              {total !== null && (
                <tfoot>
                  <tr>
                    <th scope="row">Total</th>
                    <td />
                    <td className="num tabular">{formatSeconds(total)}</td>
                    <td />
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
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

      <section aria-label="Run details" className="rs-sec" data-row="true">
        <DisclosureRow id="ck-run" label="Run details" summary={[report.kb_version && `KB ${report.kb_version}`, report.profile].filter(Boolean).join(' · ')}>
          <dl className="rs-dl rs-run">
            {meta.map(([k, v]) => (
              <Fragment key={k}>
                <dt>{k}</dt>
                <dd className="mono">{v ?? '—'}</dd>
              </Fragment>
            ))}
          </dl>
        </DisclosureRow>
      </section>
    </div>
  )
}
