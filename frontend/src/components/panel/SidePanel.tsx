import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { ArrowLeft, FileText, FileUp, Library, Paperclip, Plus, X } from 'lucide-react'
import { BlurIn, Skeleton } from '../../motion'
import { questionDraft } from '../../suggestions'
import type { Assessment } from '../../state/useAssessment'
import { EvidenceViewer } from '../EvidenceViewer'
import { citationCounts } from '../thread/sources'
import { CrossFade } from './CrossFade'
import { SourcesList } from './SourcesList'
import './panel.css'

export interface SidePanelProps {
  /** The app state from `useAssessment()`. */
  assessment: Assessment
  /** Slide-over id/aria hooks for the top-bar toggle below 1180 px. */
  id?: string
}

/** The folder with a document, a spare slot and a "+" slot drawn on a faint grid (the Sources card artwork). */
function SourcesArt() {
  return (
    <div className="pn-art" aria-hidden="true">
      <div className="pn-folder">
        <span className="pn-folder-tab" />
        <span className="pn-folder-main">
          <FileUp size={13} strokeWidth={1.5} />
        </span>
        <span className="pn-folder-slot" />
        <span className="pn-folder-slot">
          <Plus size={11} strokeWidth={1.5} />
        </span>
      </div>
    </div>
  )
}

const SourcesSkeleton = () => (
  <div role="status" aria-label="Loading sources" className="pn-skel">
    <Skeleton height={92} radius={12} />
    <Skeleton height={13} width="84%" style={{ alignSelf: 'center' }} />
    <Skeleton height={13} width="58%" style={{ alignSelf: 'center' }} />
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 15 }}>
      <Skeleton height={32} width="46%" radius={8} />
      <Skeleton height={32} width="46%" radius={8} />
    </div>
  </div>
)

const ChipsSkeleton = ({ rows, full = false }: { rows: number; full?: boolean }) => (
  <div role="status" aria-label="Loading" className={full ? 'pn-skel' : 'pn-chips'}>
    {Array.from({ length: rows }, (_, i) => (
      <Skeleton key={i} height={full ? 32 : 42} width={full ? '100%' : i % 3 === 2 ? '54%' : '40%'} radius={full ? 10 : 12} />
    ))}
  </div>
)

/**
 * Right panel (thread only): Sources card (or the evidence viewer / all-sources list), Suggested tasks and Suggested
 * questions. Cards enter with skeletons that cross-fade (blur 4 px to 0, 80 ms apart) into content once the report exists.
 * Below 1180 px it is a slide-over from the top bar's button; below 760 px a bottom sheet.
 */
export function SidePanel({ assessment: a, id = 'side-panel' }: SidePanelProps) {
  const { report } = a
  const ready = !!report
  const settled = ready || !!a.refusal || !!a.failure
  const sources = useMemo(() => report?.sources ?? [], [report?.sources])
  const counts = useMemo(() => (report ? citationCounts(report) : {}), [report])
  const questions = useMemo(
    () => [...(report?.clarification_questions ?? [])].sort((x, y) => x.priority - y.priority),
    [report?.clarification_questions],
  )
  const evidenceOpen = !!a.citedId
  const listOpen = a.sourcesOpen && !evidenceOpen
  /** The citation that was opened from the all-sources list: Back returns there. */
  const [listOrigin, setListOrigin] = useState<string | null>(null)
  const fromList = !!a.citedId && listOrigin === a.citedId

  const back = () => {
    a.closeCitation()
    if (fromList) a.setSourcesOpen(true)
    setListOrigin(null)
  }

  // Slide-over: Escape closes it (the lightbox and drawers handle Escape first and stop it).
  const { panelOpen, setPanelOpen } = a
  useEffect(() => {
    if (!panelOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && window.matchMedia?.('(max-width: 1179px)').matches) setPanelOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [panelOpen, setPanelOpen])

  // Bottom sheet (< 760 px): drag the handle down to dismiss; a quick flick is enough.
  const sheet = useRef<HTMLElement>(null)
  const drag = useRef<{ y: number; t: number; dy: number } | null>(null)
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = { y: e.clientY, t: Date.now(), dy: 0 }
    e.currentTarget.setPointerCapture(e.pointerId)
    if (sheet.current) sheet.current.style.transition = 'none'
  }
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || !sheet.current) return
    d.dy = Math.max(0, e.clientY - d.y)
    sheet.current.style.transform = `translateY(${d.dy}px)`
  }
  const onUp = () => {
    const d = drag.current
    drag.current = null
    if (!d || !sheet.current) return
    sheet.current.style.transition = ''
    sheet.current.style.transform = ''
    const velocity = d.dy / Math.max(1, Date.now() - d.t)
    if (d.dy > 100 || velocity > 0.11) setPanelOpen(false)
  }

  const sourcesBody = () => {
    if (evidenceOpen) {
      return (
        <EvidenceViewer
          key={a.citedId}
          cardId={a.citedId!}
          runId={a.activeRunId}
          fallback={sources.find((s) => s.id === a.citedId)}
          onBack={back}
          onClose={() => {
            a.closeCitation()
            setListOrigin(null)
          }}
        />
      )
    }
    if (listOpen) {
      return (
        <>
          <header className="ev-head">
            <button type="button" className="ev-icon-btn" onClick={() => a.setSourcesOpen(false)} aria-label="Back">
              <ArrowLeft size={18} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <h3 className="ev-title">All sources</h3>
            <span className="ev-count tabular">{sources.length}</span>
          </header>
          <p className="pn-note">The sources cited in this report, by document.</p>
          <SourcesList
            sources={sources}
            counts={counts}
            selectedId={a.citedId}
            onOpen={(cardId) => {
              setListOrigin(cardId)
              a.cite(cardId)
            }}
          />
        </>
      )
    }
    return (
      <>
        <h2 className="pn-title">Sources</h2>
        <CrossFade ready={settled} index={0} skeleton={<SourcesSkeleton />}>
          <SourcesArt />
          <p className="pn-lede">
            {ready
              ? `Answers cite AFS slides, application notes and Table 1 — ${sources.length} ${sources.length === 1 ? 'card' : 'cards'} in this report.`
              : 'No sources were cited: this enquiry was not assessed.'}
          </p>
          {ready && (
            <>
              <div className="pn-actions">
                <button type="button" className="btn btn-sm" onClick={a.attachFile}>
                  <Paperclip size={16} strokeWidth={1.75} aria-hidden="true" /> Attach file
                </button>
                <button type="button" className="btn btn-sm" onClick={a.openSources}>
                  <FileText size={16} strokeWidth={1.75} aria-hidden="true" /> All sources
                </button>
              </div>
              <p className="pn-foot">
                <button type="button" onClick={a.openSources}>
                  <Library size={14} strokeWidth={1.75} aria-hidden="true" /> Browse sources cited here
                </button>
              </p>
            </>
          )}
        </CrossFade>
      </>
    )
  }

  return (
    <aside ref={sheet} id={id} className="pn" data-open={a.panelOpen} aria-label="Sources and suggestions">
      <div className="pn-handle" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} aria-hidden="true">
        <span />
      </div>
      <button type="button" className="icon-square pn-close" aria-label="Close panel" onClick={() => a.setPanelOpen(false)}>
        <X size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>

      <BlurIn y={8} delay={120} duration={400} className="pn-card" as="section">
        {sourcesBody()}
      </BlurIn>

      <BlurIn y={8} delay={200} duration={400} className="pn-card" as="section">
        <h2 className="pn-title">Suggested tasks</h2>
        <CrossFade ready={settled} index={1} skeleton={<ChipsSkeleton rows={3} />}>
          {ready ? (
            <div className="pn-chips">
              {a.tasks.map((t) => (
                <button key={t.id} type="button" className="pn-chip" onClick={() => a.runTask(t.action)}>
                  {t.label.replaceAll('e-mail', 'e\u2011mail')}
                </button>
              ))}
            </div>
          ) : (
            <p className="pn-note">Suggestions appear once an assessment exists.</p>
          )}
        </CrossFade>
      </BlurIn>

      <BlurIn y={8} delay={280} duration={400} className="pn-card" as="section">
        <h2 className="pn-title">Suggested questions</h2>
        <CrossFade ready={settled} index={2} skeleton={<ChipsSkeleton rows={4} full />}>
          {ready ? (
            questions.length > 0 ? (
              <div className="pn-questions">
                {questions.map((q) => (
                  <button key={q.question} type="button" className="pn-q" title={q.question} aria-label={q.question} onClick={() => a.fillComposer(questionDraft(q.question))}>
                    <span>{q.question}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="pn-note">The report has no open questions.</p>
            )
          ) : (
            <p className="pn-note">Questions appear once an assessment exists.</p>
          )}
        </CrossFade>
      </BlurIn>
    </aside>
  )
}
