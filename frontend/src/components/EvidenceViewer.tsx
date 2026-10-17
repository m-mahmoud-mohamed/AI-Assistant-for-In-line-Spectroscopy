import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink, FileWarning, Quote, X } from 'lucide-react'
import { api, pageImageUrl } from '../api'
import { cardPage, formatCitation } from '../labels'
import type { SourceRef } from '../types'
import { ScopeBadge } from './report/SourcesTab'

interface EvidenceViewerProps {
  cardId: string
  /** The report's own copy of the source, used while the card loads or when the backend is offline. */
  fallback?: SourceRef
  onClose?: () => void
}

function PageImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted">
        <FileWarning size={14} aria-hidden="true" /> Page image unavailable.
      </p>
    )
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className="w-full rounded border border-line bg-white"
    />
  )
}

/** One evidence card (`GET /api/kb/cards/{id}`): citation, scope badge, verbatim quote and the highlighted page. */
export function EvidenceViewer({ cardId, fallback, onClose }: EvidenceViewerProps) {
  const card = useQuery({ queryKey: ['card', cardId], queryFn: () => api.getCard(cardId), retry: false })
  const data = card.data

  const citation = data ? formatCitation(data) : fallback?.citation
  const quote = data?.quote ?? fallback?.quote
  const scope = data?.scope ?? fallback?.scope
  const url = data?.url ?? fallback?.url ?? null
  const page = data ? cardPage(data) : null

  return (
    <article aria-label={`Evidence ${citation ?? cardId}`} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {citation && <span className="font-mono text-sm font-semibold">{citation}</span>}
        {scope && <ScopeBadge scope={scope} />}
        <span className="font-mono text-[11px] text-muted">{cardId}</span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close evidence"
            className="ml-auto rounded p-1 text-muted hover:text-fg"
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>

      {card.isPending && !fallback && <p className="text-sm text-muted">Loading {cardId}…</p>}
      {card.isError && !fallback && (
        <p role="status" className="text-sm text-muted">
          Card {cardId} could not be loaded.
        </p>
      )}
      {card.isError && fallback && <p className="text-xs text-muted">Backend offline: showing the report's copy of the quote.</p>}

      {quote && (
        <blockquote className="flex gap-2 border-l-2 border-fiber-cyan pl-3 text-sm italic">
          <Quote size={12} aria-hidden="true" className="mt-1 shrink-0 text-muted" />
          <span>{quote}</span>
        </blockquote>
      )}
      {data?.claim && (
        <p className="text-sm">
          <span className="text-muted">Supports:</span> {data.claim}
        </p>
      )}
      {url && (
        <p className="text-xs">
          <a href={url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 break-all">
            <ExternalLink size={12} aria-hidden="true" /> {url}
          </a>
          {data?.retrieved_at && <span className="ml-2 text-muted">retrieved {data.retrieved_at}</span>}
        </p>
      )}
      {page && citation && (
        <PageImage
          key={`${page.doc}-${page.page}-${cardId}`}
          src={pageImageUrl(page.doc, page.page, cardId)}
          alt={`${citation} with the quote highlighted`}
        />
      )}
    </article>
  )
}
