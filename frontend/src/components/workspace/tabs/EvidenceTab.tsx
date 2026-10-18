import { useEffect, useRef } from 'react'
import { FileSearch } from 'lucide-react'
import { EvidenceViewer } from '../../EvidenceViewer'
import { SourcesList } from '../../panel/SourcesList'
import { SectionSkeleton } from '../TabSection'
import type { TabProps } from './types'

/**
 * Every source the report cites, grouped by document, and the selected one beside it: the page with the quote
 * highlighted, the claim it supports and, for web sources, the verification checks. On a narrow pane the viewer
 * takes the list's place (Back returns). A citation chip anywhere in the app lands here with its source selected.
 */
export function EvidenceTab({ assessment: a, model }: TabProps) {
  const detailRef = useRef<HTMLDivElement>(null)
  const cited = a.citedId
  const selected = model.sources.find((s) => s.id === cited)
  const arrivedWith = useRef(cited)

  // Arriving from a citation chip: move focus to the source so the keyboard follows the click.
  // On mount only: choosing another row afterwards keeps focus on the list.
  useEffect(() => {
    if (arrivedWith.current) detailRef.current?.focus({ preventScroll: true })
  }, [])

  // Keep the selected row in sight in the list.
  useEffect(() => {
    if (!cited) return
    document.querySelector<HTMLElement>('.evt-list [aria-current="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [cited])

  if (!model.pending.sources && model.sources.length === 0 && !cited) {
    return <p className="rs-muted">No sources are attached to this report. Ask in Conversation for the evidence behind the recommendation before sharing it.</p>
  }

  return (
    <div className="evt" data-selected={cited ? 'true' : 'false'}>
      <div className="evt-list">
        {model.pending.sources ? (
          <SectionSkeleton label="sources" rows={6} />
        ) : (
          <>
            <p className="rs-muted evt-note">
              {model.sources.length} {model.sources.length === 1 ? 'source' : 'sources'} cited in this report, by document.
            </p>
            <SourcesList sources={model.sources} counts={model.counts} selectedId={cited} onOpen={a.cite} />
          </>
        )}
      </div>
      <div ref={detailRef} className="evt-detail" role="region" tabIndex={-1} aria-label="Selected source">
        {cited ? (
          <EvidenceViewer key={cited} cardId={cited} runId={a.activeRunId} fallback={selected} onBack={a.closeCitation} onClose={a.closeCitation} />
        ) : (
          <p className="evt-empty">
            <FileSearch size={18} strokeWidth={1.75} aria-hidden="true" />
            Select a source to see its page with the quote highlighted.
          </p>
        )}
      </div>
    </div>
  )
}
