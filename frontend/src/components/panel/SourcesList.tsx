import { useId } from 'react'
import type { SourceRef } from '../../types'
import { sourceHost } from '../thread/sources'
import { groupSources } from './sourceGroups'
import { ScopeTag } from './ScopeTag'
import './panel.css'

interface SourcesListProps {
  sources: SourceRef[]
  /** How many times each card is cited in the report. */
  counts: Record<string, number>
  selectedId?: string | null
  onOpen: (cardId: string) => void
}

/** Every source of the report grouped by document (S01…S05, Table 1, Web); a row opens the evidence viewer. */
export function SourcesList({ sources, counts, selectedId, onOpen }: SourcesListProps) {
  const uid = useId()
  if (sources.length === 0) return <p className="ev-muted">No sources are attached to this report.</p>
  return (
    <div className="sl">
      {groupSources(sources).map((g) => (
        <section key={g.key} aria-labelledby={`${uid}-${g.key}`}>
          <h3 id={`${uid}-${g.key}`} className="sl-group">
            <span>{g.title}</span>
            <span className="tabular">{g.sources.length}</span>
          </h3>
          <ul>
            {g.sources.map((s) => {
              const uses = counts[s.id] ?? 0
              const host = s.scope === 'external' ? sourceHost(s) : null
              return (
                <li key={s.id}>
                  <button type="button" className="sl-row" aria-current={s.id === selectedId ? 'true' : undefined} onClick={() => onOpen(s.id)}>
                    <span className="sl-top">
                      <span className="sl-cite">{host ?? s.citation}</span>
                      {uses > 0 && (
                        <span className="sl-uses tabular">
                          {uses} {uses === 1 ? 'use' : 'uses'}
                        </span>
                      )}
                    </span>
                    <ScopeTag scope={s.scope} source={s} />
                    <span className="sl-quote clamp-2">{s.quote}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}
