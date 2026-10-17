import { AlertTriangle, BookOpen, CircleHelp, Globe, Lightbulb, User, type LucideIcon } from 'lucide-react'
import type { ClaimType, Segment } from '../../types'

/** Every claim type carries an icon and a text label as well as a colour (colour-blind safe). */
const CLAIM: Record<ClaimType, { label: string; icon: LucideIcon; color: string; outline?: boolean }> = {
  CLIENT: { label: 'Client', icon: User, color: 'var(--afs-prism-500)' },
  AFS: { label: 'AFS', icon: BookOpen, color: 'var(--fiber-cyan)' },
  EXTERNAL: { label: 'External', icon: Globe, color: 'var(--fiber-magenta)' },
  ASSUMPTION: { label: 'Assumption', icon: AlertTriangle, color: 'var(--fiber-orange)' },
  PROPOSAL: { label: 'Proposal', icon: Lightbulb, color: 'var(--text-muted)' },
  UNKNOWN: { label: 'Unknown', icon: CircleHelp, color: 'var(--text-muted)', outline: true },
}

export function ClaimChip({ type }: { type: ClaimType }) {
  const { label, icon: Icon, color, outline } = CLAIM[type]
  return (
    <span
      data-claim={type}
      className="mr-1.5 inline-flex items-center gap-1 rounded border px-1.5 py-0.5 align-middle text-[11px] font-semibold uppercase tracking-wide text-fg"
      style={{
        borderColor: color,
        borderStyle: outline ? 'dashed' : 'solid',
        background: outline ? 'transparent' : `color-mix(in srgb, ${color} 16%, transparent)`,
      }}
    >
      <Icon size={11} aria-hidden="true" style={{ color }} />
      {label}
    </span>
  )
}

interface ClaimTextProps {
  segments: Segment[]
  /** Called with the evidence card ID when a citation is clicked. */
  onCite?: (cardId: string) => void
  /** Card ID → display citation (e.g. `S01 p.17`); falls back to the card ID. */
  citations?: Record<string, string>
  /** Text shown when there are no segments. */
  empty?: string
}

/** Renders claim-typed segments: chip (icon + label + colour), text, then clickable citations. */
export function ClaimText({ segments, onCite, citations = {}, empty }: ClaimTextProps) {
  if (segments.length === 0) {
    return empty ? <p className="text-sm text-muted">{empty}</p> : null
  }
  return (
    <div className="flex flex-col gap-1">
      {segments.map((s, i) => (
        <p key={i} className="text-sm leading-relaxed">
          <ClaimChip type={s.claim_type} />
          <span>{s.text}</span>
          {s.evidence_ids.map((id) => {
            const label = citations[id] ?? id
            return onCite ? (
              <button
                key={id}
                type="button"
                onClick={() => onCite(id)}
                aria-label={`Show source ${label}`}
                className="ml-1 rounded px-1 font-mono text-xs text-[var(--link)] underline decoration-dotted underline-offset-2 hover:bg-surface-raised"
              >
                [{label}]
              </button>
            ) : (
              <span key={id} className="ml-1 font-mono text-xs text-muted">
                [{label}]
              </span>
            )
          })}
        </p>
      ))}
    </div>
  )
}
