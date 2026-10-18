import { plainText } from '../../../labels'
import { ClaimText } from '../../report/ClaimText'
import { PlanTimeline } from '../../report/PlanTimeline'
import { TabSection } from '../TabSection'
import type { TabProps } from './types'

/** The feasibility study: objective, clarify-first items, every step, references, setup, validation and go / no-go, then the risks, assumptions and the decision basis. */
export function PlanTab({ assessment: a, report, model }: TabProps) {
  const claim = { onCite: a.cite, citations: model.citations }
  const { pending } = model
  return (
    <div className="tab-stack">
      <TabSection title="Feasibility plan" pending={pending.plan} rows={6}>
        <PlanTimeline plan={report.feasibility_plan} {...claim} />
      </TabSection>

      {(pending.risks || report.risks.length > 0) && (
        <TabSection title="Risks" pending={pending.risks} rows={3}>
          <div className="tbl-wrap">
            <table aria-label="Risks and mitigations" className="tbl">
              <thead>
                <tr>
                  <th scope="col">Risk</th>
                  <th scope="col">Effect</th>
                  <th scope="col">Mitigation</th>
                </tr>
              </thead>
              <tbody>
                {report.risks.map((r, i) => (
                  <tr key={i}>
                    <td>
                      <ClaimText segments={r.risk} {...claim} />
                    </td>
                    <td>{plainText(r.effect)}</td>
                    <td>{plainText(r.mitigation)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabSection>
      )}

      {(pending.assumptions || report.assumptions.length > 0) && (
        <TabSection title="Assumptions to confirm" pending={pending.assumptions} rows={2}>
          <div className="tbl-wrap">
            <table aria-label="Assumptions" className="tbl">
              <thead>
                <tr>
                  <th scope="col">Assumption</th>
                  <th scope="col">Confirm with</th>
                </tr>
              </thead>
              <tbody>
                {report.assumptions.map((s, i) => (
                  <tr key={i}>
                    <td>{s.assumption}</td>
                    <td>{plainText(s.to_confirm_with)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabSection>
      )}

      {(pending.basis || report.decision_basis.length > 0) && (
        <TabSection title="Decision basis" pending={pending.basis} rows={2}>
          <ClaimText segments={report.decision_basis} {...claim} />
        </TabSection>
      )}
    </div>
  )
}
