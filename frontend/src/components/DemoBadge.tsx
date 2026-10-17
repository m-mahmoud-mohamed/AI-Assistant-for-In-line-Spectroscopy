import { FlaskConical } from 'lucide-react'

/** Shown wherever mock data stands in for the backend (offline only). Icon + text, not colour alone. */
export function DemoBadge({ title = 'Backend offline: showing built-in demo data, not a real assessment.' }: { title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 rounded border border-fiber-orange px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
      style={{ background: 'color-mix(in srgb, var(--fiber-orange) 14%, transparent)' }}
    >
      <FlaskConical size={11} aria-hidden="true" className="text-fiber-orange" />
      Demo data
    </span>
  )
}
