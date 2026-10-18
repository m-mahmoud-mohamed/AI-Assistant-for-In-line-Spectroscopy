import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ExternalLink, FileWarning, Globe, Maximize2, X } from 'lucide-react'
import { api, pageImageUrl } from '../api'
import { cardPage, formatCitation } from '../labels'
import { Skeleton } from '../motion'
import { sourceTitle } from '../sourceTitle'
import type { SourceRef } from '../types'
import { CopyButton } from './report/CopyButton'
import { Lightbox } from './panel/Lightbox'
import { ScopeTag } from './panel/ScopeTag'
import { TIER_LABEL } from './panel/tiers'
import { VerificationChecklist } from './panel/Verification'
import './panel/panel.css'

interface EvidenceViewerProps {
  cardId: string
  /** Run the citation was clicked in; needed to look up verified web cards (`EXT-…`). */
  runId?: string | null
  /** The report's own copy of the source, used while the card loads or when the backend is offline. */
  fallback?: SourceRef
  /** Back arrow in the header (to the sources list when the viewer replaces it on a narrow pane). */
  onBack?: () => void
  onClose?: () => void
}

const isWeb = (id: string) => id.startsWith('EXT')

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function PageImage({ src, alt, onZoom }: { src: string; alt: string; onZoom: () => void }) {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  if (state === 'failed') {
    return (
      <p className="ev-muted ev-inline">
        <FileWarning size={14} strokeWidth={1.75} aria-hidden="true" /> Page image unavailable.
      </p>
    )
  }
  return (
    <button type="button" className="ev-page" onClick={onZoom} aria-label="Enlarge the source page" data-state={state}>
      {state === 'loading' && <Skeleton className="ev-page-skel" height="100%" radius={10} />}
      <img src={src} alt={alt} loading="lazy" onLoad={() => setState('ready')} onError={() => setState('failed')} />
      <span className="ev-zoom" aria-hidden="true">
        <Maximize2 size={13} strokeWidth={1.75} />
      </span>
    </button>
  )
}

/**
 * One evidence card (`GET /api/kb/cards/{id}`): citation, scope, the verbatim quote highlighted, the page image
 * (click to zoom) and the claim it supports. Verified web sources add domain, tier, retrieval date, the link out and
 * the verification checklist.
 */
export function EvidenceViewer({ cardId, runId, fallback, onBack, onClose }: EvidenceViewerProps) {
  const web = isWeb(cardId)
  const card = useQuery({
    queryKey: web ? ['card', cardId, runId ?? null] : ['card', cardId],
    queryFn: () => api.getCard(cardId, web ? runId : undefined),
    retry: false,
  })
  const [zoom, setZoom] = useState(false)
  const data = card.data

  const citation = data ? formatCitation(data) : fallback?.citation
  const quote = data?.quote ?? fallback?.quote
  const scope = data?.scope ?? fallback?.scope
  const url = data?.url ?? fallback?.url ?? null
  const doi = data?.doi ?? fallback?.doi ?? null
  const verification = data?.verification ?? fallback?.verification ?? null
  const retrieved = formatDate(verification?.retrieved_at ?? data?.retrieved_at)
  const page = data ? cardPage(data) : null
  const domain = verification?.domain ?? (url ? safeHost(url) : null)
  const pageSrc = page ? pageImageUrl(page.doc, page.page, cardId) : null
  const title = sourceTitle({ id: cardId, citation, quote, claim: data?.claim, url, verification })

  return (
    <article aria-label={`Evidence ${title}`} className="ev">
      <header className="ev-head">
        {onBack && (
          <button type="button" className="ev-icon-btn ev-back" onClick={onBack} aria-label="Back">
            <ArrowLeft size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}
        <div className="ev-titles">
          <h3 className="ev-title">{title}</h3>
          {citation && citation !== title && <p className="ev-sub">{citation}</p>}
        </div>
        {quote && <CopyButton label="evidence excerpt" text={`${citation ?? cardId}\n“${quote}”${url ? `\n${url}` : ''}`} />}
        {onClose && (
          <button type="button" className="ev-icon-btn ev-close" onClick={onClose} aria-label="Close evidence">
            <X size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}
      </header>

      <div className="ev-meta">
        {scope && <ScopeTag scope={scope} source={{ verification }} />}
      </div>

      {card.isPending && !fallback && (
        <div role="status" aria-label="Loading source" className="ev-skel">
          <Skeleton height={14} />
          <Skeleton height={14} width="82%" />
          <Skeleton height={120} radius={10} />
        </div>
      )}
      {card.isError && !fallback && (
        <p role="status" className="ev-muted">
          This source could not be loaded.
        </p>
      )}
      {card.isError && fallback && <p className="ev-muted">Backend offline: showing the report's copy of the quote.</p>}

      {quote && (
        <blockquote className="ev-quote">
          <mark>{quote}</mark>
        </blockquote>
      )}
      {data?.claim && (
        <p className="ev-claim">
          <strong>Supports</strong> {data.claim}
        </p>
      )}

      {(web || url) && (
        <div className="ev-web">
          <dl className="ev-facts">
            {domain && (
              <div>
                <dt>Source</dt>
                <dd>
                  <Globe size={13} strokeWidth={1.75} aria-hidden="true" /> {domain}
                  {verification && <span className="pill pill-info">{TIER_LABEL[verification.domain_tier]}</span>}
                </dd>
              </div>
            )}
            {retrieved && (
              <div>
                <dt>Retrieved</dt>
                <dd className="tabular">{retrieved}</dd>
              </div>
            )}
            {doi && (
              <div>
                <dt>DOI</dt>
                <dd>
                  <a href={`https://doi.org/${doi}`} target="_blank" rel="noopener noreferrer" className="mono ev-break">
                    {doi}
                  </a>
                </dd>
              </div>
            )}
          </dl>
          {url && (
            <a href={url} target="_blank" rel="noopener noreferrer" className="btn btn-sm ev-open">
              Open source <ExternalLink size={14} strokeWidth={1.75} aria-hidden="true" />
            </a>
          )}
          {verification && <VerificationChecklist verification={verification} />}
        </div>
      )}

      {pageSrc && citation && (
        <>
          <PageImage key={`${page?.doc}-${page?.page}-${cardId}`} src={pageSrc} alt={`${citation} with the quote highlighted`} onZoom={() => setZoom(true)} />
          <Lightbox open={zoom} src={pageSrc} alt={`${citation} with the quote highlighted`} onClose={() => setZoom(false)} />
        </>
      )}
    </article>
  )
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}
