import { MethodHeatmap } from '../../../charts/MethodHeatmap'
import { RecommendationItem } from '../../report/Recommendations'
import { EngineCandidates } from '../EngineCandidates'
import { TabSection } from '../TabSection'
import type { TabProps } from './types'

/** Which methods fit and why: the candidate table with the rule engine's statuses and reasons, then every recommendation in full. */
export function MethodsTab({ assessment: a, model }: TabProps) {
  const claim = { onCite: a.cite, citations: model.citations }
  const { pending } = model
  const streamNames = Object.fromEntries(model.streams.map((s) => [s.id, s.name]))
  return (
    <div className="tab-stack">
      <TabSection title="Candidate methods" pending={pending.candidates} rows={5}>
        {a.reportPartial && a.enginePreview ? (
          <EngineCandidates engine={a.enginePreview} />
        ) : model.candidates.length > 0 ? (
          <MethodHeatmap candidates={model.candidates} recommendations={model.recs} streamNames={streamNames} {...claim} />
        ) : (
          <p className="rs-muted">Candidate comparisons were not stored with this report. Ask in Conversation to compare the methods for this process.</p>
        )}
      </TabSection>
      <TabSection title="Recommendations in detail" pending={pending.recs} rows={5}>
        {model.recs.length > 0 ? (
          <ul className="rc-grid">
            {model.recs.map((rec, i) => (
              <RecommendationItem key={i} rec={rec} streams={model.streams} {...claim} />
            ))}
          </ul>
        ) : (
          <p className="rs-muted">No method is recommended yet. Add the target measurement and process conditions in Conversation to refine the assessment.</p>
        )}
      </TabSection>
    </div>
  )
}
