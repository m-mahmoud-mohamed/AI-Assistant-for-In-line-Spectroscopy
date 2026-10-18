import type { ReactNode } from 'react'
import { CircleAlert, Unplug } from 'lucide-react'
import { Skeleton } from '../../motion'
import { STAGE_LABELS, type PipelineState } from '../../pipeline/reducer'
import { formatSeconds, stageCounts, stagesRun, totalSeconds } from '../../pipeline/status'
import type { Stage } from '../../types'
import type { Assessment } from '../../state/useAssessment'
import { RefusalCard } from '../RefusalCard'
import { StageIcon, WebSourceList } from '../thread/PipelineSteps'
import { TAB_IDS, TAB_LABEL } from '../../state/tabs'

/** What each stage does, in plain words, for the live view. */
const STAGE_NOTE: Record<Stage, string> = {
  scope: 'Checks that the enquiry is a process-measurement question',
  extract: 'Reads the streams, targets, matrix and premises from the text',
  normalise: "Maps the client's terms to AFS method and fiber vocabulary",
  rules: 'Deterministic rules score the methods and set the decision status',
  retrieve: 'Selects the AFS evidence cards for the candidates',
  web: 'Searches for external sources and verifies every quote in code',
  draft: 'Writes the cited report from the rules and the evidence',
  verify: 'Checks every citation, quote and policy',
  repair: 'Fixes the claims that failed, in one pass',
  render: 'Assembles the final report',
}

function HeaderSkeleton() {
  return (
    <>
      <div className="rh-bar">
        <div className="rp-w rh-bar-in">
          <div className="rh-id">
            <Skeleton height={20} width="min(320px, 60%)" radius={6} />
            <Skeleton height={12} width={120} radius={6} style={{ marginTop: 8 }} />
          </div>
          <Skeleton height={32} width={200} radius={8} />
        </div>
      </div>
      <div className="rp-w rh-body">
        <div className="rh-pills">
          <Skeleton height={24} width={150} radius={999} />
          <Skeleton height={24} width={96} radius={999} />
        </div>
        <Skeleton height={16} width="86%" radius={6} />
        <ul className="rh-facts" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <li key={i}>
              <Skeleton height={64} radius={10} />
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}

function TabsSkeleton() {
  return (
    <div className="rtabs" aria-hidden="true">
      <div className="rp-w rt-skel">
        {TAB_IDS.map((id, i) => (
          <Skeleton key={id} height={14} width={TAB_LABEL[id].length * 8 + (i % 3) * 4} radius={6} />
        ))}
      </div>
    </div>
  )
}

/** The run, larger than the conversation's list: each stage with what it does, what it found so far and its time; web sources as they are verified. */
function LivePipeline({ state }: { state: PipelineState }) {
  const total = totalSeconds(state)
  return (
    <section className="lp" aria-label="Run progress">
      <h3 className="lp-title">Assessing the enquiry</h3>
      <p className="rs-muted lp-sub">A standard run takes about a minute. The report appears here when it is verified.</p>
      <ol className="lp-list">
        {stagesRun(state).map((stage) => {
          const st = state.stages[stage]
          const found = stageCounts(st).join(', ')
          return (
            <li key={stage} data-status={st.status} className="lp-row">
              <StageIcon status={st.status} />
              <div className="lp-main">
                <span className="lp-name">{STAGE_LABELS[stage]}</span>
                <span className="lp-note">{STAGE_NOTE[stage]}</span>
                {stage === 'web' && state.webSources.length > 0 && <WebSourceList sources={state.webSources} />}
              </div>
              <span className="lp-found">{found}</span>
              <span className="lp-time tabular">{formatSeconds(st.seconds) ?? ''}</span>
            </li>
          )
        })}
      </ol>
      {total !== null && <p className="lp-total tabular">{formatSeconds(total)} so far</p>}
    </section>
  )
}

/** A centred message on the report pane: a refusal, a failed run, or nothing to show yet. */
function StatePane({ children }: { children: ReactNode }) {
  return (
    <section className="rp rp-state" aria-label="Assessment report">
      <div className="rp-state-box">{children}</div>
    </section>
  )
}

/**
 * The report pane while there is no report: the header and tab bar as skeletons with the live pipeline centred below
 * (a run in flight), or the refusal card, or the failure with "Try again".
 */
export function PendingPane({ assessment: a }: { assessment: Assessment }) {
  if (a.refusal) {
    return (
      <StatePane>
        <RefusalCard reason={a.refusal.reason} label={a.refusal.label} suggestions={a.refusal.suggestions} onExample={a.fillComposer} />
      </StatePane>
    )
  }
  if (a.failure) {
    return (
      <StatePane>
        <p role="alert" className="inline-error">
          <CircleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>{a.failure}</span>
          <button type="button" className="link-btn" onClick={() => void a.rerun(a.deep)}>
            Try again
          </button>
        </p>
      </StatePane>
    )
  }
  if (a.loading || a.sessionLoading) {
    return (
      <section className="rp rp-pending" aria-label="Assessment report" aria-busy="true">
        <HeaderSkeleton />
        <TabsSkeleton />
        <div className="rp-w lp-wrap">
          {a.offline && (
            <p className="notice">
              <Unplug size={16} strokeWidth={1.75} aria-hidden="true" />
              <span>
                PRISM's API is not reachable — start it with <code>make api</code>.
              </span>
            </p>
          )}
          <LivePipeline state={a.run.state} />
        </div>
      </section>
    )
  }
  return (
    <StatePane>
      <p className="rs-muted">There is no assessment report in this session yet.</p>
    </StatePane>
  )
}
