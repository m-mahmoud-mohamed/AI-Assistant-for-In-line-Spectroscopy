import { AlertTriangle, BookOpen, CircleHelp, Globe, Lightbulb, User, type LucideIcon } from 'lucide-react'
import { RevealWords } from '../../motion'
import type { ClaimType, Segment } from '../../types'

/** Every claim type carries an icon and a text label as well as a colour (colour-blind safe). */
const CLAIM: Record<ClaimType, { label: string; icon: LucideIcon; color: string; outline?: boolean }> = {
  CLIENT: { label: 'Client', icon: User, color: 'var(--violet)' },
  AFS: { label: 'AFS', icon: BookOpen, color: 'var(--star)' },
  EXTERNAL: { label: 'External', icon: Globe, color: 'var(--fiber-magenta)' },
  ASSUMPTION: { label: 'Assumption', icon: AlertTriangle, color: 'var(--status-warn)' },
  PROPOSAL: { label: 'Proposal', icon: Lightbulb, color: 'var(--muted)' },
  UNKNOWN: { label: 'Unknown', icon: CircleHelp, color: 'var(--muted)', outline: true },
}

/**
 * Small claim-type marker: icon + label, a quiet tint of the type's colour. Only what matters is marked: external
 * sources, assumptions and unknowns. AFS (its citation chip names the source), client facts (the facts table says
 * so) and proposals (the default of a recommendation) render nothing.
 */
const MARKED: readonly ClaimType[] = ['EXTERNAL', 'ASSUMPTION', 'UNKNOWN']

export function ClaimChip({ type }: { type: ClaimType }) {
  if (!MARKED.includes(type)) return null
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
  /** Reveal the words one by one, the first starting after `delay` ms (a fresh report's direct answer). */
  reveal?: { delay: number }
}

/** Claim-typed segments: marker, text, then superscript citation chips. */
export function ClaimText({ segments, onCite, citations = {}, empty, reveal }: ClaimTextProps) {
  if (segments.length === 0) return empty ? <p className="rs-muted">{empty}</p> : null
  return (
    <div className="rs-claims">
      {segments.map((s, i) => (
        <p key={i} className="rs-p">
          <ClaimChip type={s.claim_type} />
          {reveal ? (
            <RevealWords text={s.text} delay={reveal.delay + i * 80} stagger={18} perWordCap={300} duration={380} blur={4} rise="0.2em" />
          ) : (
            s.text
          )}
          {s.evidence_ids.map((id) => (
            <Cite key={id} id={id} label={citations[id] ?? id} onCite={onCite} />
          ))}
        </p>
      ))}
    </div>
  )
}
