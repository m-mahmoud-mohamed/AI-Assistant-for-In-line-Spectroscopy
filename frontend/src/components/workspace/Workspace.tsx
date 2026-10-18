import './workspace.css'
import { useRef } from 'react'
import { DEFAULT_SPLIT_RATIO, type useSplitRatio } from '../../hooks/useSplitRatio'
import type { Assessment } from '../../state/useAssessment'
import { Conversation } from './Conversation'
import { ReportPane } from './ReportPane'

interface WorkspaceProps {
  assessment: Assessment
  /** At least 1180 px wide: the conversation and the report side by side. Narrower: one at a time, chosen by the segmented control. */
  wide: boolean
  splitRatio: ReturnType<typeof useSplitRatio>
}

const PANES = [
  { id: 'conversation', label: 'Conversation' },
  { id: 'report', label: 'Report' },
] as const

/**
 * The thread view: a conversation column (enquiry, run, follow-ups, composer) beside the report pane (header, tabs,
 * panel). Below 1180 px a segmented control at the top toggles between the two.
 */
export function Workspace({ assessment: a, wide, splitRatio }: WorkspaceProps) {
  const pane = a.pane
  const panesRef = useRef<HTMLDivElement>(null)
  const resize = (ratio: number) => {
    const width = (panesRef.current?.clientWidth ?? 0) - 8
    splitRatio.setRatio(width > 740 ? Math.min((width - 420) / width, Math.max(320 / width, ratio)) : ratio)
  }
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
      <div className="ws-panes" ref={panesRef}>
        <div className="ws-pane ws-pane-conv" hidden={!wide && pane !== 'conversation'}>
          <Conversation assessment={a} />
        </div>
        {wide && <div role="separator" aria-label="Resize conversation and report" aria-orientation="vertical" aria-valuemin={25} aria-valuemax={65} aria-valuenow={Math.round(splitRatio.ratio * 100)} tabIndex={0} className="ws-divider" data-print-hide
          onDoubleClick={() => splitRatio.setRatio(DEFAULT_SPLIT_RATIO)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); resize(splitRatio.ratio + (e.key === 'ArrowRight' ? 0.02 : -0.02)) }
            else if (e.key === 'Home') { e.preventDefault(); splitRatio.setRatio(DEFAULT_SPLIT_RATIO) }
          }}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture?.(e.pointerId); e.preventDefault() }}
          onPointerMove={(e) => {
            if (!e.currentTarget.hasPointerCapture?.(e.pointerId)) return
            const rect = panesRef.current?.getBoundingClientRect()
            if (rect && rect.width > 8) resize((e.clientX - rect.left) / (rect.width - 8))
          }}
          onPointerUp={(e) => e.currentTarget.releasePointerCapture?.(e.pointerId)}
        />}
        <div className="ws-pane ws-pane-report" hidden={!wide && pane !== 'report'}>
          <ReportPane assessment={a} visible={wide || pane === 'report'} />
        </div>
      </div>
    </div>
  )
}
