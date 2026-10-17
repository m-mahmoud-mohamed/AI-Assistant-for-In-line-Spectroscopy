import type { PremiseCheck, PremiseVerdict } from '../../types'
import { ClaimText } from './ClaimText'

const PREMISE: Record<PremiseVerdict, { emoji: string; label: string; color: string }> = {
  SUPPORTED: { emoji: '✅', label: 'Supported', color: 'var(--status-ok)' },
  CONTRADICTED: { emoji: '⛔', label: 'Contradicted', color: 'var(--status-bad)' },
  UNVERIFIABLE: { emoji: '❔', label: 'Unverifiable', color: 'var(--status-warn)' },
}

interface PremiseChecksProps {
  checks: PremiseCheck[]
  onCite?: (cardId: string) => void
  citations?: Record<string, string>
}

/** The client's own assumptions, checked against the evidence. */
export function PremiseChecks({ checks, onCite, citations }: PremiseChecksProps) {
  return (
    <section className="rounded-lg border border-line bg-surface p-4" aria-labelledby="premise-heading">
      <h2 id="premise-heading" className="mb-2 text-sm font-bold">
        Premise checks
      </h2>
      {checks.length === 0 ? (
        <p className="text-sm text-muted">The enquiry states no premises to check.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {checks.map((c, i) => {
            const v = PREMISE[c.verdict]
            return (
              <li key={i} className="border-l-2 pl-3" style={{ borderColor: v.color }}>
                <div className="mb-1 flex flex-wrap items-center gap-2 text-sm font-semibold">
                  <span
                    className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs"
                    style={{ borderColor: v.color }}
                  >
                    <span aria-hidden="true">{v.emoji}</span>
                    {v.label}
                  </span>
                  <span>{c.premise}</span>
                </div>
                <ClaimText segments={c.explanation} onCite={onCite} citations={citations} />
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
