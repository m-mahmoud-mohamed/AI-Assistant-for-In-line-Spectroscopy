import { useEffect, useRef } from 'react'
import { Beaker, Briefcase, FlaskConical, Globe, Factory, Microscope, type LucideIcon } from 'lucide-react'
import type { Scope, SourceRef } from '../../types'

const SCOPE: Record<Scope, { label: string; icon: LucideIcon }> = {
  method_general: { label: 'Method (general)', icon: Microscope },
  process_application: { label: 'Process application', icon: Factory },
  lab_study: { label: 'Lab study', icon: FlaskConical },
  in_vitro_poc: { label: 'In-vitro proof of concept', icon: Beaker },
  business_context: { label: 'Business context', icon: Briefcase },
  external: { label: 'External', icon: Globe },
}

export function ScopeBadge({ scope }: { scope: Scope }) {
  const { label, icon: Icon } = SCOPE[scope]
  return (
    <span className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[11px] font-semibold">
      <Icon size={11} aria-hidden="true" className="text-fiber-cyan" />
      {label}
    </span>
  )
}

function SourceItem({ source, selected }: { source: SourceRef; selected: boolean }) {
  const ref = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView?.({ block: 'nearest' })
  }, [selected])
  return (
    <li
      ref={ref}
      id={`source-${source.id}`}
      aria-current={selected ? 'true' : undefined}
      className="rounded-lg border bg-surface p-4"
      style={{ borderColor: selected ? 'var(--afs-prism-500)' : 'var(--border)' }}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-semibold">{source.citation}</span>
        <ScopeBadge scope={source.scope} />
        <span className="font-mono text-[11px] text-muted">{source.id}</span>
      </div>
      <blockquote className="border-l-2 border-line pl-3 text-sm italic">{source.quote}</blockquote>
      {source.url && (
        <a href={source.url} target="_blank" rel="noreferrer noopener" className="mt-2 inline-block break-all text-xs">
          {source.url}
        </a>
      )}
    </li>
  )
}

interface SourcesTabProps {
  sources: SourceRef[]
  /** Card ID to highlight (the citation the user clicked). */
  selectedId?: string | null
}

/** Every cited card with citation, scope badge and verbatim quote; external sources listed separately. */
export function SourcesTab({ sources, selectedId }: SourcesTabProps) {
  if (sources.length === 0) {
    return <p className="text-sm text-muted">No sources attached. They appear once the API returns the full report.</p>
  }
  const afs = sources.filter((s) => s.scope !== 'external')
  const external = sources.filter((s) => s.scope === 'external')
  const group = (id: string, title: string, list: SourceRef[]) =>
    list.length > 0 && (
      <section aria-labelledby={id}>
        <h2 id={id} className="mb-2 text-xs font-bold uppercase tracking-[0.16em] text-muted">
          {title}
        </h2>
        <ul className="flex flex-col gap-3">
          {list.map((s) => (
            <SourceItem key={s.id} source={s} selected={s.id === selectedId} />
          ))}
        </ul>
      </section>
    )
  return (
    <div className="flex flex-col gap-5">
      {group('sources-afs', 'AFS sources', afs)}
      {group('sources-external', 'External sources', external)}
    </div>
  )
}
