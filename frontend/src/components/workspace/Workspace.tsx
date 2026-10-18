import './workspace.css'
import type { Assessment } from '../../state/useAssessment'
import { Conversation } from './Conversation'
import { ReportPane } from './ReportPane'

interface WorkspaceProps {
  assessment: Assessment
  /** At least 1180 px wide: the conversation and the report side by side. Narrower: one at a time, chosen by the segmented control. */
  wide: boolean
}

const PANES = [
  { id: 'conversation', label: 'Conversation' },
  { id: 'report', label: 'Report' },
] as const

/**
 * The thread view: a conversation column (enquiry, run, follow-ups, composer) beside the report pane (header, tabs,
 * panel). Below 1180 px a segmented control at the top toggles between the two.
 */
export function Workspace({ assessment: a, wide }: WorkspaceProps) {
  const pane = a.pane
  return (
    <div className="ws" data-wide={wide} data-pane={wide ? undefined : pane}>
      {!wide && (
        <div className="ws-seg-bar" data-print-hide>
          <div role="group" aria-label="Show" className="ws-seg">
            {PANES.map((p) => (
              <button key={p.id} type="button" aria-pressed={pane === p.id} className="ws-seg-btn" onClick={() => a.setPane(p.id)}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="ws-panes">
        <div className="ws-pane ws-pane-conv" hidden={!wide && pane !== 'conversation'}>
          <Conversation assessment={a} />
        </div>
        <div className="ws-pane ws-pane-report" hidden={!wide && pane !== 'report'}>
          <ReportPane assessment={a} visible={wide || pane === 'report'} />
        </div>
      </div>
    </div>
  )
}
