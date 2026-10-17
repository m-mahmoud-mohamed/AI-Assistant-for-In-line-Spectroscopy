import './thread.css'
import { useId } from 'react'
import { BadgeCheck, Globe, Link2, Sparkle } from 'lucide-react'
import type { SourceRef } from '../../types'
import { sourceTitle } from '../../sourceTitle'
import { Appear } from './Appear'
import { isVerifiedWeb, rankSources, SCOPE_PLAIN, sourceHost, webDomain } from './sources'

/** The citation for the card's meta line: short enough to sit beside the scope ("S01 Table p.6"), words kept together. */
const metaCitation = (citation: string) => citation.replace(/^(\w+) Table 1 \(p\.(\d+)\)$/, '$1 Table p.$2').replaceAll(' ', '\u00a0')

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
          const title = sourceTitle(s)
          // "S01 p.14 · AFS app note"; a web card shows its domain (its title when it has none of its own).
          const scopeLabel = external ? (domain && domain !== title ? domain : SCOPE_PLAIN.external) : SCOPE_PLAIN[s.scope]
          const metaTitle = external ? scopeLabel : `${s.citation} · ${scopeLabel}`
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
                  aria-label={`Open source ${title}, ${s.citation}`}
                >
                  <span className="clamp-2" style={{ fontWeight: 500 }} title={title}>
                    {title}
                  </span>
                  <span className="source-meta">
                    <ScopeIcon size={16} strokeWidth={2} aria-hidden="true" className={external ? 'source-glyph is-web' : 'source-glyph'} fill={external ? 'none' : 'currentColor'} />
                    <span className="source-scope" title={metaTitle}>
                      {external ? (
                        scopeLabel
                      ) : (
                        <>
                          <span className="nb">{metaCitation(s.citation) + ' ·'}</span> <span className="nb">{scopeLabel}</span>
                        </>
                      )}
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
