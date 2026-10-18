import { Ban, CircleDashed, ShieldAlert, ShieldCheck, ShieldHalf, type LucideIcon } from 'lucide-react'
import { ROLE_LABEL } from '../../labels'
import type { RecRole, Recommendation, Segment, Stream } from '../../types'
import { Cite, ClaimChip, ClaimText } from './ClaimText'

const STRENGTH: Record<string, { icon: LucideIcon; tone: 'ok' | 'warn' | 'bad' | 'info' }> = {
  Strong: { icon: ShieldCheck, tone: 'ok' },
  Moderate: { icon: ShieldHalf, tone: 'info' },
  Weak: { icon: ShieldAlert, tone: 'warn' },
  Blocked: { icon: Ban, tone: 'bad' },
}

const STRENGTH_HINT =
  'Computed by code from Table 1 sample-type fit, AFS application evidence, open critical unknowns and blocking findings.'

function EvidenceStrengthBadge({ strength }: { strength: string | null }) {
  const meta = strength ? STRENGTH[strength] : undefined
  const Icon = meta?.icon ?? CircleDashed
  return (
    <span title={STRENGTH_HINT} className={`pill pill-${meta?.tone ?? 'neutral'}`}>
      <Icon size={13} strokeWidth={2} aria-hidden="true" />
      Evidence: {strength ?? 'not rated'}
    </span>
  )
}

function RolePill({ role }: { role: RecRole }) {
  return (
    <span className={`pill ${role === 'PRIMARY' ? 'pill-info' : 'pill-neutral'}`} data-role={role}>
      {ROLE_LABEL[role]}
    </span>
  )
}

interface RecommendationProps {
  rec: Recommendation
  /** The report's streams: a rec is tagged with stream names only when there are two or more. */
  streams?: Stream[]
  onCite?: (cardId: string) => void
  citations?: Record<string, string>
  /** `summary`: the first reasons and conditions as bullets (Overview). `full`: rationale, conditions and limitations (Methods). */
  variant?: 'summary' | 'full'
  /** Summary only: opens the full detail (the Methods tab). */
  onMore?: () => void
}

const REASONS = 3
const CONDITIONS = 2

function Bullets({ segments, limit, onCite, citations }: { segments: Segment[]; limit: number } & Pick<RecommendationProps, 'onCite' | 'citations'>) {
  return (
    <ul className="rc-list">
      {segments.slice(0, limit).map((s, i) => (
        <li key={i}>
          <ClaimChip type={s.claim_type} />
          {s.text}
          {s.evidence_ids.map((id) => (
            <Cite key={id} id={id} label={citations?.[id] ?? id} onCite={onCite} />
          ))}
        </li>
      ))}
    </ul>
  )
}

/** One recommendation: method · technique, role, evidence strength, then why (cited), conditions and, in full, limitations. */
export function RecommendationItem({ rec, streams = [], onCite, citations, variant = 'full', onMore }: RecommendationProps) {
  const names = streams.length >= 2 ? rec.applies_to.map((id) => streams.find((s) => s.id === id)?.name ?? id) : []
  const claim = { onCite, citations }
  const hidden =
    Math.max(0, rec.rationale.length - REASONS) + Math.max(0, rec.conditions.length - CONDITIONS) + rec.limitations.length
  return (
    <li aria-label={`${rec.methods.join(' + ')} recommendation`} className="rc" data-role={rec.role}>
      <div className="rc-head">
        <strong className="rs-strong">
          {rec.methods.join(' + ')} · {rec.technique}
        </strong>
        <RolePill role={rec.role} />
        <EvidenceStrengthBadge strength={rec.evidence_strength} />
        {names.length > 0 && <span className="rs-stream-note">for {names.join(', ')}</span>}
      </div>
      {variant === 'summary' ? (
        <>
          <Bullets segments={rec.rationale} limit={REASONS} {...claim} />
          {rec.conditions.length > 0 && (
            <div className="rs-sub">
              <span className="rs-sub-label">Conditions</span>
              <Bullets segments={rec.conditions} limit={CONDITIONS} {...claim} />
            </div>
          )}
          {hidden > 0 && onMore && (
            <button type="button" className="link-btn rc-more" onClick={onMore}>
              {hidden} more in Methods
            </button>
          )}
        </>
      ) : (
        <>
          <div className="rs-sub">
            <span className="rs-sub-label">Why</span>
            <ClaimText segments={rec.rationale} {...claim} />
          </div>
          {rec.conditions.length > 0 && (
            <div className="rs-sub">
              <span className="rs-sub-label">Conditions</span>
              <ClaimText segments={rec.conditions} {...claim} />
            </div>
          )}
          {rec.limitations.length > 0 && (
            <div className="rs-sub">
              <span className="rs-sub-label">Limitations</span>
              <ClaimText segments={rec.limitations} {...claim} />
            </div>
          )}
        </>
      )}
    </li>
  )
}
