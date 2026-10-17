import { Ban, CircleDashed, ShieldAlert, ShieldCheck, ShieldHalf, type LucideIcon } from 'lucide-react'
import type { Recommendation, RecRole } from '../../types'
import { ClaimText } from './ClaimText'

const STRENGTH: Record<string, { icon: LucideIcon; color: string }> = {
  Strong: { icon: ShieldCheck, color: 'var(--status-ok)' },
  Moderate: { icon: ShieldHalf, color: 'var(--afs-prism-500)' },
  Weak: { icon: ShieldAlert, color: 'var(--status-warn)' },
  Blocked: { icon: Ban, color: 'var(--status-bad)' },
}

const STRENGTH_HINT =
  'Computed by code from Table 1 sample-type fit, AFS application evidence, open critical unknowns and blocking findings.'

export function EvidenceStrengthBadge({ strength }: { strength: string | null }) {
  const meta = strength ? STRENGTH[strength] : undefined
  const Icon = meta?.icon ?? CircleDashed
  const color = meta?.color ?? 'var(--text-muted)'
  return (
    <span
      title={STRENGTH_HINT}
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold"
      style={{ borderColor: color, borderStyle: meta ? 'solid' : 'dashed' }}
    >
      <Icon size={12} aria-hidden="true" style={{ color }} />
      Evidence: {strength ?? 'not rated'}
    </span>
  )
}

const ROLE_LABEL: Record<RecRole, string> = {
  PRIMARY: 'Primary',
  COMPARISON: 'Comparison',
  CONDITIONAL: 'Conditional',
  SCREENING: 'Screening',
  NOT_RECOMMENDED: 'Not recommended',
}

const ROLE_ORDER: RecRole[] = ['PRIMARY', 'COMPARISON', 'CONDITIONAL', 'SCREENING', 'NOT_RECOMMENDED']

interface MethodCardProps {
  rec: Recommendation
  compact?: boolean
  onCite?: (cardId: string) => void
  citations?: Record<string, string>
}

export function MethodCard({ rec, compact, onCite, citations }: MethodCardProps) {
  return (
    <article className="rounded-lg border border-line bg-surface p-4" aria-label={`${rec.methods.join(' + ')} recommendation`}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-bold">
          {rec.methods.join(' + ')} · <span className="font-medium">{rec.technique}</span>
        </h3>
        <span className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-[11px] uppercase">
          {ROLE_LABEL[rec.role]}
        </span>
        <EvidenceStrengthBadge strength={rec.evidence_strength} />
        {rec.applies_to.length > 0 && (
          <span className="font-mono text-xs text-muted">streams: {rec.applies_to.join(', ')}</span>
        )}
      </div>
      <ClaimText segments={rec.rationale} onCite={onCite} citations={citations} />
      {!compact && (
        <>
          {rec.conditions.length > 0 && (
            <div className="mt-3">
              <h4 className="mb-1 text-xs font-bold uppercase tracking-wide text-muted">Conditions</h4>
              <ClaimText segments={rec.conditions} onCite={onCite} citations={citations} />
            </div>
          )}
          {rec.limitations.length > 0 && (
            <div className="mt-3">
              <h4 className="mb-1 text-xs font-bold uppercase tracking-wide text-muted">Limitations</h4>
              <ClaimText segments={rec.limitations} onCite={onCite} citations={citations} />
            </div>
          )}
        </>
      )}
    </article>
  )
}

interface MethodsTabProps {
  recommendations: Recommendation[]
  onCite?: (cardId: string) => void
  citations?: Record<string, string>
}

/** All recommendations grouped by role, with rationale, conditions and limitations. */
export function MethodsTab({ recommendations, onCite, citations }: MethodsTabProps) {
  return (
    <div className="flex flex-col gap-5">
      {ROLE_ORDER.map((role) => {
        const recs = recommendations.filter((r) => r.role === role)
        if (recs.length === 0) return null
        return (
          <section key={role} aria-labelledby={`role-${role}`} className="flex flex-col gap-3">
            <h2 id={`role-${role}`} className="text-xs font-bold uppercase tracking-[0.16em] text-muted">
              {ROLE_LABEL[role]}
            </h2>
            {recs.map((r, i) => (
              <MethodCard key={i} rec={r} onCite={onCite} citations={citations} />
            ))}
          </section>
        )
      })}
    </div>
  )
}
