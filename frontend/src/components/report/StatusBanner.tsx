import { AlertTriangle, Ban, ClipboardCheck, type LucideIcon } from 'lucide-react'
import type { DecisionStatus } from '../../types'

const STATUS: Record<DecisionStatus, { label: string; icon: LucideIcon; color: string; detail: string }> = {
  PROVISIONAL: {
    label: 'Provisional',
    icon: ClipboardCheck,
    color: 'var(--status-ok)',
    detail: 'Based on the stated facts and cited AFS sources. Confirm the open questions before committing.',
  },
  INSUFFICIENT_INFORMATION: {
    label: 'Insufficient information',
    icon: AlertTriangle,
    color: 'var(--status-warn)',
    detail: 'Key facts are missing. Answer the clarification questions before a method can be chosen.',
  },
  OUTSIDE_SUPPORTED_SCOPE: {
    label: 'Outside supported scope',
    icon: Ban,
    color: 'var(--status-bad)',
    detail: 'The request goes beyond what the AFS sources support. Any concept shown is for screening only.',
  },
}

/** Decision status computed by the rule engine (the LLM may only make it stricter). */
export function StatusBanner({ status }: { status: DecisionStatus }) {
  const { label, icon: Icon, color, detail } = STATUS[status]
  return (
    <div
      role="status"
      data-status={status}
      className="flex items-start gap-3 rounded-lg border-2 bg-surface px-4 py-3"
      style={{ borderColor: color }}
    >
      <Icon size={20} aria-hidden="true" className="mt-0.5 shrink-0" style={{ color }} />
      <div>
        <div className="font-bold">Status: {label}</div>
        <p className="text-sm text-muted">{detail}</p>
      </div>
    </div>
  )
}
