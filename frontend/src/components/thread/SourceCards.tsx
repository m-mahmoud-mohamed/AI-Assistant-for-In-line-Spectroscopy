import './thread.css'
import { useId } from 'react'
import { BadgeCheck, Globe, Link2, Sparkle } from 'lucide-react'
import type { SourceRef } from '../../types'
import { Appear } from './Appear'
import { isVerifiedWeb, rankSources, SCOPE_PLAIN, sourceHost, webDomain } from './sources'

export interface SourceCardsProps {
  sources: SourceRef[]
  counts: Record<string, number>
  onOpen: (cardId: string) => void
  onMore: () => void
  /** Blur the heading and cards in left to right (a fresh run). */
  animate?: boolean
  /** Delay before the heading starts, ms (cards follow 60 ms apart). */
  delay?: number
}

/** "Sources" heading plus up to three source cards and a "+N More" card. */
export function SourceCards({ sources, counts, onOpen, onMore, animate = false, delay = 0 }: SourceCardsProps) {
  const titleId = useId()
  if (sources.length === 0) return null
  const ranked = rankSources(sources, counts)
  const shown = ranked.slice(0, 3)
  const more = ranked.length - shown.length
  const cardDelay = (i: number) => delay + 120 + i * 60
  return (
    <section aria-labelledby={titleId}>
      <Appear animate={animate} delay={delay} y={6}>
        <h2 id={titleId} className="section-title">
          <Link2 size={20} strokeWidth={1.75} aria-hidden="true" />
          Sources
        </h2>
      </Appear>
      <ul className="source-row">
        {shown.map((s, i) => {
          const external = s.scope === 'external'
          const verified = isVerifiedWeb(s)
          const domain = external ? (webDomain(s) ?? sourceHost(s)) : null
          const scopeLabel = external ? (domain ?? SCOPE_PLAIN.external) : SCOPE_PLAIN[s.scope]
          const ScopeIcon = external ? Globe : Sparkle
          return (
            <li key={s.id} style={{ display: 'flex', minWidth: 0 }}>
              <Appear animate={animate} delay={cardDelay(i)} y={6} style={{ display: 'flex', width: '100%' }}>
                <button
                  type="button"
                  className="source-card"
                  data-verified={verified ? 'true' : undefined}
                  style={{ width: '100%' }}
                  onClick={() => onOpen(s.id)}
                  aria-label={`Open source ${s.citation}`}
                >
                  <span className="clamp-2" style={{ fontWeight: 500 }}>
                    {s.citation}
                  </span>
                  <span className="source-meta">
                    <ScopeIcon size={16} strokeWidth={2} aria-hidden="true" className={external ? 'source-glyph is-web' : 'source-glyph'} fill={external ? 'none' : 'currentColor'} />
                    <span className="source-scope" title={scopeLabel}>
                      {scopeLabel}
                    </span>
                    {counts[s.id] ? <span className="tabular source-uses">• {counts[s.id]}</span> : null}
                    {verified && (
                      <span className="source-verified" title="Verified: the quote was found at the source and the domain is allowed">
                        <BadgeCheck size={14} strokeWidth={2} aria-hidden="true" />
                        <span className="sr-only">Verified</span>
                      </span>
                    )}
                  </span>
                </button>
              </Appear>
            </li>
          )
        })}
        {more > 0 && (
          <li style={{ display: 'flex' }}>
            <Appear animate={animate} delay={cardDelay(shown.length)} y={6} style={{ display: 'flex', width: '100%' }}>
              <button type="button" className="source-card source-more" onClick={onMore}>
                +{more} More
              </button>
            </Appear>
          </li>
        )}
      </ul>
    </section>
  )
}
