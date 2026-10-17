import { Globe, Link2, Sparkle, BadgeCheck } from 'lucide-react'
import { BlurIn } from '../../motion'
import type { SourceRef } from '../../types'
import { SCOPE_INFO } from '../report/scope'
import { rankSources, sourceHost } from './sources'

export interface SourceCardsProps {
  sources: SourceRef[]
  counts: Record<string, number>
  onOpen: (cardId: string) => void
  onMore: () => void
  /** Delay before the heading starts, ms (cards follow 60 ms apart). */
  delay?: number
}

/** "Sources" heading plus up to three source cards and a "+N More" card. */
export function SourceCards({ sources, counts, onOpen, onMore, delay = 0 }: SourceCardsProps) {
  if (sources.length === 0) return null
  const ranked = rankSources(sources, counts)
  const shown = ranked.slice(0, 3)
  const more = ranked.length - shown.length
  return (
    <section aria-labelledby="thread-sources-title">
      <BlurIn delay={delay} y={6}>
        <h2 id="thread-sources-title" className="section-title">
          <Link2 size={20} strokeWidth={1.75} aria-hidden="true" />
          Sources
        </h2>
      </BlurIn>
      <ul className="source-row">
        {shown.map((s, i) => {
          const host = sourceHost(s)
          const external = s.scope === 'external'
          const ScopeIcon = external ? Globe : Sparkle
          return (
            <li key={s.id} style={{ display: 'flex', minWidth: 0 }}>
              <BlurIn delay={delay + 120 + i * 60} y={6} style={{ display: 'flex', width: '100%' }}>
                <button type="button" className="source-card" style={{ width: '100%' }} onClick={() => onOpen(s.id)} aria-label={`Open source ${s.citation}`}>
                  <span className="clamp-2" style={{ fontWeight: 500 }}>
                    {s.citation}
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--body)', minWidth: 0 }}>
                    <ScopeIcon size={16} strokeWidth={2} aria-hidden="true" style={{ color: external ? 'var(--body)' : 'var(--star)', flex: 'none' }} fill={external ? 'none' : 'var(--star)'} />
                    <span title={external ? (host ?? undefined) : SCOPE_INFO[s.scope].label} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                      {external ? (host ?? SCOPE_INFO[s.scope].label) : SCOPE_INFO[s.scope].label}
                    </span>
                    {counts[s.id] ? <span className="tabular" style={{ flex: 'none', whiteSpace: 'nowrap' }}>• {counts[s.id]}</span> : null}
                    {external && <BadgeCheck size={14} strokeWidth={1.75} aria-label="Verified" style={{ color: 'var(--status-ok)', flex: 'none' }} />}
                  </span>
                </button>
              </BlurIn>
            </li>
          )
        })}
        {more > 0 && (
          <li style={{ display: 'flex' }}>
            <BlurIn delay={delay + 120 + shown.length * 60} y={6} style={{ display: 'flex', width: '100%' }}>
              <button type="button" className="source-card" style={{ width: '100%', justifyContent: 'center', alignItems: 'center', padding: '0 6px', whiteSpace: 'nowrap', textAlign: 'center' }} onClick={onMore}>
                +{more} More
              </button>
            </BlurIn>
          </li>
        )}
      </ul>
    </section>
  )
}
