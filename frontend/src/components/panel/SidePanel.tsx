import { useMemo } from 'react'
import { ArrowLeft, FileText, FolderOpen, Paperclip, X } from 'lucide-react'
import { BlurIn, Skeleton } from '../../motion'
import { questionDraft } from '../../suggestions'
import type { Assessment } from '../../state/useAssessment'
import { EvidenceViewer } from '../EvidenceViewer'
import { SourcesTab } from '../report/SourcesTab'

export interface SidePanelProps {
  /** The app state from `useAssessment()`. */
  assessment: Assessment
  /** Slide-over id/aria hooks for the top-bar toggle below 1180 px. */
  id?: string
}

const CardSkeleton = ({ rows, chips = false }: { rows: number; chips?: boolean }) => (
  <div role="status" aria-label="Loading" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
    {Array.from({ length: rows }, (_, i) => (
      <Skeleton key={i} height={chips ? 40 : 30} width={chips ? (i % 3 === 2 ? '58%' : '38%') : '100%'} radius={10} />
    ))}
  </div>
)

/**
 * Right panel (thread only): Sources card (or the evidence viewer when a citation is open), Suggested tasks,
 * Suggested questions. Cards fade in with skeleton blocks that cross-fade into content once the report exists.
 */
export function SidePanel({ assessment: a, id = 'side-panel' }: SidePanelProps) {
  const { report } = a
  const ready = !!report
  const sources = report?.sources ?? []
  const questions = useMemo(
    () => [...(report?.clarification_questions ?? [])].sort((x, y) => x.priority - y.priority),
    [report?.clarification_questions],
  )
  const evidenceOpen = !!a.citedId
  const listOpen = a.sourcesOpen && !evidenceOpen

  const sourcesBody = () => {
    if (evidenceOpen) {
      return (
        <EvidenceViewer
          cardId={a.citedId!}
          fallback={sources.find((s) => s.id === a.citedId)}
          onClose={a.closeCitation}
        />
      )
    }
    if (listOpen) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <button type="button" className="link-btn" style={{ alignSelf: 'flex-start' }} onClick={() => a.setSourcesOpen(false)}>
            <ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" /> Back
          </button>
          <SourcesTab sources={sources} selectedId={a.citedId} />
        </div>
      )
    }
    if (!ready) {
      return (
        <div role="status" aria-label="Loading sources" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Skeleton height={96} radius={12} />
          <Skeleton height={14} width="80%" style={{ alignSelf: 'center' }} />
          <Skeleton height={14} width="55%" style={{ alignSelf: 'center' }} />
        </div>
      )
    }
    return (
      <BlurIn y={0} blur={4} duration={350}>
        <div className="dots-grid sources-art" aria-hidden="true">
          <div className="folder">
            <FolderOpen size={34} strokeWidth={1.25} />
          </div>
        </div>
        <p style={{ margin: '4px 8px 16px', textAlign: 'center', fontSize: 14, lineHeight: 1.5 }}>
          Answers cite AFS slides, application notes and Table 1 — {sources.length} {sources.length === 1 ? 'card' : 'cards'} in this report.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-sm" onClick={a.attachFile}>
            <Paperclip size={16} strokeWidth={1.75} aria-hidden="true" /> Attach file
          </button>
          <button type="button" className="btn btn-sm" onClick={a.openSources}>
            <FileText size={16} strokeWidth={1.75} aria-hidden="true" /> All sources
          </button>
        </div>
        <p style={{ margin: '14px 0 0', textAlign: 'center', fontSize: 12 }}>
          <button type="button" className="link-btn" onClick={a.openSources}>
            Browse knowledge base
          </button>
        </p>
      </BlurIn>
    )
  }

  return (
    <aside id={id} className="panel" data-open={a.panelOpen} aria-label="Sources and suggestions">
      <button type="button" className="icon-square panel-close" aria-label="Close panel" onClick={() => a.setPanelOpen(false)}>
        <X size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>

      <BlurIn y={8} delay={120} duration={400} className="panel-card" as="section" style={{ marginBottom: 20 }}>
        <h2>{evidenceOpen ? 'Evidence' : 'Sources'}</h2>
        {sourcesBody()}
      </BlurIn>

      <BlurIn y={8} delay={200} duration={400} className="panel-card" as="section" style={{ marginBottom: 20 }}>
        <h2>Suggested tasks</h2>
        {ready ? (
          <BlurIn y={0} blur={4} duration={350}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {a.tasks.map((t) => (
                <button key={t.id} type="button" className="chip" onClick={() => a.runTask(t.action)}>
                  {t.label}
                </button>
              ))}
            </div>
          </BlurIn>
        ) : (
          <CardSkeleton rows={3} chips />
        )}
      </BlurIn>

      <BlurIn y={8} delay={280} duration={400} className="panel-card" as="section" style={{ marginBottom: 0 }}>
        <h2>Suggested questions</h2>
        {ready ? (
          questions.length > 0 ? (
            <BlurIn y={0} blur={4} duration={350}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {questions.map((q) => (
                  <button
                    key={q.question}
                    type="button"
                    className="chip"
                    style={{ width: '100%' }}
                    title={q.why_it_matters}
                    onClick={() => a.fillComposer(questionDraft(q.question))}
                  >
                    {q.question}
                  </button>
                ))}
              </div>
            </BlurIn>
          ) : (
            <p style={{ margin: 0, fontSize: 14, color: 'var(--muted)' }}>The report has no open questions.</p>
          )
        ) : (
          <CardSkeleton rows={4} />
        )}
      </BlurIn>
    </aside>
  )
}

