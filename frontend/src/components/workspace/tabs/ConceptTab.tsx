import { CircleHelp } from 'lucide-react'
import { HOW_READ, plainText, sentenceCase, slotLabel } from '../../../labels'
import { ClaimText } from '../../report/ClaimText'
import { UnknownGroups } from '../../report/UnknownGroups'
import { TabSection } from '../TabSection'
import type { TabProps } from './types'

const KIND: Record<string, string> = {
  method: 'Method',
  technique: 'Technique',
  fiber: 'Fiber',
  matrix: 'Matrix',
  optics: 'Optics',
  unit: 'Unit',
  other: 'Term',
}

/** What is to be measured and how, and what we know: the measurement concept per stream, the client's own words, the key unknowns, how their terms were read. */
export function ConceptTab({ assessment: a, report, model }: TabProps) {
  const claim = { onCite: a.cite, citations: model.citations }
  const { pending } = model
  const concept = report.measurement_concept
  const interpretations = report.interpretations ?? []
  return (
    <div className="tab-stack">
      <TabSection title="Measurement concept" pending={pending.concept} rows={3}>
        {concept.length > 0 ? (
          <div className="mc-list">
            {concept.map((m, i) => (
              <div key={i} className="mc">
                {model.streamName(m.stream_id) && <strong className="rs-strong">{model.streamName(m.stream_id)}</strong>}
                <dl className="mc-grid">
                  <div>
                    <dt>Probe geometry</dt>
                    <dd>{m.probe_geometry}</dd>
                  </div>
                  <div>
                    <dt>Location</dt>
                    <dd>{m.location}</dd>
                  </div>
                  <div>
                    <dt>Fiber link</dt>
                    <dd>{m.fiber_link}</dd>
                  </div>
                </dl>
                <ClaimText segments={m.notes} {...claim} />
              </div>
            ))}
          </div>
        ) : (
          <p className="rs-muted">No measurement concept in this report.</p>
        )}
      </TabSection>

      <TabSection title="What the client told us" pending={pending.requirements} rows={4}>
        {model.facts.length > 0 ? (
          <div className="tbl-wrap">
            <table aria-label="Facts stated by the client" className="tbl">
              <thead>
                <tr>
                  <th scope="col">Fact</th>
                  <th scope="col">Value</th>
                  <th scope="col">Client's words</th>
                </tr>
              </thead>
              <tbody>
                {model.facts.map((f, i) => (
                  <tr key={i}>
                    <th scope="row" className="hm-method">
                      {slotLabel(f.slot)}
                      {model.streamName(f.stream_id) && <span className="rs-stream-note"> · {model.streamName(f.stream_id)}</span>}
                    </th>
                    <td>{sentenceCase(plainText(f.value))}</td>
                    <td>
                      <span className="rs-quote">
                        {f.provenance === 'confirmed' ? 'Confirmed in conversation' : `“${f.quote}”`}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="rs-muted">No facts extracted yet.</p>
        )}
      </TabSection>

      {(pending.requirements || model.unknowns.length > 0) && (
        <TabSection title="Key unknowns" pending={pending.requirements} rows={2}>
          <UnknownGroups groups={model.unknownGroups} streamName={model.streamName} />
        </TabSection>
      )}

      {interpretations.length > 0 && (
        <TabSection title="How we read your terms">
          <div className="tbl-wrap">
            <table aria-label="How the client's terms were read" className="tbl">
              <thead>
                <tr>
                  <th scope="col">Client's term</th>
                  <th scope="col">Read as</th>
                  <th scope="col">Match</th>
                  <th scope="col">Alternatives</th>
                </tr>
              </thead>
              <tbody>
                {interpretations.map((t, i) => (
                  <tr key={i}>
                    <th scope="row" className="hm-method">
                      “{t.term}”
                    </th>
                    <td>
                      <strong className="rs-strong">{t.canonical ?? 'not resolved'}</strong>{' '}
                      <span className="rs-muted-note">{KIND[t.kind] ?? t.kind}</span>
                    </td>
                    <td>
                      <span className="rs-muted-note">{HOW_READ[t.how] ?? t.how}</span>
                      {t.ambiguous && (
                        <span className="pill pill-warn" style={{ marginLeft: 8 }}>
                          <CircleHelp size={12} strokeWidth={2} aria-hidden="true" />
                          Ambiguous
                        </span>
                      )}
                    </td>
                    <td className="rs-muted-inline">{t.alternatives.length > 0 ? t.alternatives.join(', ') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabSection>
      )}
    </div>
  )
}
