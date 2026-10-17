import { AlertTriangle, BookOpen, CircleHelp, Globe, Lightbulb, User, type LucideIcon } from 'lucide-react'
import type { ClaimType, Segment } from '../../types'
import { Rv } from './reveal'
import { useRevealDelay } from './revealState'

/** Every claim type carries an icon and a text label as well as a colour (colour-blind safe). */
const CLAIM: Record<ClaimType, { label: string; icon: LucideIcon; color: string; outline?: boolean }> = {
  CLIENT: { label: 'Client', icon: User, color: '#6a42e0' },
  AFS: { label: 'AFS', icon: BookOpen, color: '#335bfb' },
  EXTERNAL: { label: 'External', icon: Globe, color: '#a12bd4' },
  ASSUMPTION: { label: 'Assumption', icon: AlertTriangle, color: '#b26b00' },
  PROPOSAL: { label: 'Proposal', icon: Lightbulb, color: '#6c6b73' },
  UNKNOWN: { label: 'Unknown', icon: CircleHelp, color: '#6c6b73', outline: true },
}

/**
 * Small claim-type marker: icon + label, a quiet tint of the type's colour. AFS is the unmarked default (its
 * citation chip already names the source), so it renders nothing.
 */
export function ClaimChip({ type }: { type: ClaimType }) {
  if (type === 'AFS') return null
  const { label, icon: Icon, color, outline } = CLAIM[type]
  return (
    <span data-claim={type} className="claim-mark" data-outline={outline ? 'true' : undefined} style={{ ['--claim' as string]: color }}>
      <Icon size={11} strokeWidth={2} aria-hidden="true" />
      {label}
    </span>
  )
}

interface CiteProps {
  id: string
  label: string
  onCite?: (cardId: string) => void
}

/** Superscript citation chip; clicking opens the evidence viewer. */
export function Cite({ id, label, onCite }: CiteProps) {
  return onCite ? (
    <button type="button" className="cite-sup" aria-label={`Show source ${label}`} onClick={() => onCite(id)}>
      {label}
    </button>
  ) : (
    <span className="cite-sup" data-static="true">
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
  /** Reveal index of the first segment inside its section (see `Rv`). */
  item?: number
}

function Segmented({ s, item, onCite, citations }: { s: Segment; item: number } & Pick<ClaimTextProps, 'onCite' | 'citations'>) {
  const delay = useRevealDelay(item)
  return (
    <p className="rs-p" data-rv={delay === null ? undefined : ""} style={delay === null ? undefined : { ['--rv-delay' as string]: `${delay + 120}ms` }}>
      <ClaimChip type={s.claim_type} />
      <Rv item={item}>{s.text}</Rv>
      {s.evidence_ids.map((id) => (
        <Cite key={id} id={id} label={citations?.[id] ?? id} onCite={onCite} />
      ))}
    </p>
  )
}

/** Claim-typed segments: marker, text, then superscript citation chips. */
export function ClaimText({ segments, onCite, citations = {}, empty, item = 0 }: ClaimTextProps) {
  if (segments.length === 0) return empty ? <p className="rs-muted">{empty}</p> : null
  return (
    <div className="rs-claims">
      {segments.map((s, i) => (
        <Segmented key={i} s={s} item={item + i} onCite={onCite} citations={citations} />
      ))}
    </div>
  )
}
