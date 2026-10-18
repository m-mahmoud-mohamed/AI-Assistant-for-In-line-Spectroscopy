import { clientFiberFrom } from '../../../charts/spectral'
import { SpectralWindowChart } from '../../../charts/SpectralWindowChart'
import { ClaimText } from '../../report/ClaimText'
import { alternateRange, excitationLabel } from '../ranges'
import { TabSection } from '../TabSection'
import type { TabProps } from './types'

/** Method, fiber and instrument windows on one axis, and the nominal range of each method with its fiber needs and caveats. */
export function SpectralTab({ assessment: a, report, rules, model }: TabProps) {
  const claim = { onCite: a.cite, citations: model.citations }
  const ranges = report.spectral_ranges
  const { pending } = model
  const showExcitation = ranges.some((r) => excitationLabel(r.excitation_nm))
  return (
    <div className="tab-stack">
      <TabSection title="Spectral windows" pending={pending.candidates && !a.spectral} rows={6}>
        {a.spectral ? (
          <SpectralWindowChart data={a.spectral} methods={model.chartMethods} clientFiber={clientFiberFrom(rules?.findings)} findings={rules?.findings} onCite={a.cite} />
        ) : (
          <p className="rs-muted">The spectral windows chart needs the knowledge base, which is not reachable right now.</p>
        )}
      </TabSection>
      <TabSection title="Nominal ranges" pending={pending.ranges} rows={3}>
        {ranges.length > 0 ? (
          <div className="tbl-wrap">
            <table aria-label="Nominal spectral ranges" className="tbl">
              <thead>
                <tr>
                  <th scope="col">Method</th>
                  <th scope="col">Nominal range</th>
                  {showExcitation && <th scope="col">Excitation</th>}
                  <th scope="col">Fiber family needed</th>
                  <th scope="col">Caveat</th>
                </tr>
              </thead>
              <tbody>
                {ranges.map((r, i) => {
                  const other = alternateRange(r.method, r.nominal_range)
                  return (
                    <tr key={i}>
                      <th scope="row" className="hm-method">
                        {r.method}
                      </th>
                      <td className="sp-range">
                        <span className="mono">{r.nominal_range}</span>
                        {other && <span className="sp-alt mono">≈ {other}</span>}
                      </td>
                      {showExcitation && <td className="mono">{excitationLabel(r.excitation_nm) ?? '—'}</td>}
                      <td>{r.fiber_family_needed}</td>
                      <td>
                        <ClaimText segments={r.caveat} {...claim} empty="No caveat stated." />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="rs-muted">No nominal ranges in this report.</p>
        )}
      </TabSection>
    </div>
  )
}
