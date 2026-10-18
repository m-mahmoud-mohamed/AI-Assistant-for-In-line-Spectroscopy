import { useId, type ReactNode } from 'react'
import { ArrowRight } from 'lucide-react'
import { Skeleton } from '../../motion'

interface TabSectionProps {
  title: string
  /** Right of the title: a "See all" link or a count. */
  aside?: ReactNode
  /** The report does not have this section yet: its skeleton shows in place of the content. */
  pending?: boolean
  /** Skeleton lines while pending. */
  rows?: number
  children: ReactNode
}

/** Placeholder lines for a section that is still being written (the last one shorter). */
export function SectionSkeleton({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div role="status" aria-label={`Loading ${label.toLowerCase()}`} className="sk">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={14} width={i === rows - 1 ? '58%' : i % 2 ? '92%' : '100%'} radius={6} />
      ))}
    </div>
  )
}

/** One labelled block of a report tab: a 15 px / 600 label (weight, not size), an optional aside, then the content or, while the section is missing, its skeleton. */
export function TabSection({ title, aside, pending = false, rows, children }: TabSectionProps) {
  const id = useId()
  return (
    <section aria-labelledby={id} aria-busy={pending || undefined} className="ts">
      <header className="ts-head">
        <h3 id={id} className="rs-label">
          {title}
        </h3>
        {pending ? undefined : aside}
      </header>
      {pending ? <SectionSkeleton label={title} rows={rows} /> : children}
    </section>
  )
}

/** "See all 5 questions →": a link-styled button that switches to the tab holding the detail. */
export function SeeAll({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" className="link-btn ts-link" onClick={onClick} data-print-hide>
      {children}
      <ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" />
    </button>
  )
}
