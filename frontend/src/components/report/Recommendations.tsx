import { Ban, CircleDashed, ShieldAlert, ShieldCheck, ShieldHalf, type LucideIcon } from 'lucide-react'
import { ROLE_LABEL } from '../../labels'
import type { RecRole, Recommendation } from '../../types'
import { ClaimText } from './ClaimText'
import { Rv } from './reveal'

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
  index: number
  onCite?: (cardId: string) => void
  citations?: Record<string, string>
}

/** One recommendation as a bullet: method · technique, role, evidence strength, rationale and conditions. */
export function RecommendationItem({ rec, index, onCite, citations }: RecommendationProps) {
  return (
    <li aria-label={`${rec.methods.join(' + ')} recommendation`} className="rs-rec">
      <div className="rs-rec-head">
        <strong className="rs-strong">
          <Rv item={index}>
            {rec.methods.join(' + ')} · {rec.technique}
          </Rv>
        </strong>
        <RolePill role={rec.role} />
        <EvidenceStrengthBadge strength={rec.evidence_strength} />
        {rec.applies_to.length > 0 && <span className="rs-mono-note">streams: {rec.applies_to.join(', ')}</span>}
      </div>
      <ClaimText segments={rec.rationale} onCite={onCite} citations={citations} item={index + 1} />
      {rec.conditions.length > 0 && (
        <div className="rs-sub">
          <span className="rs-sub-label">Conditions</span>
          <ClaimText segments={rec.conditions} onCite={onCite} citations={citations} item={index + 2} />
        </div>
      )}
    </li>
  )
}
