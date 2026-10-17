import type { DecisionStatus } from '../../types'
import { STATUS } from './status'

/** Decision status computed by the rule engine (the LLM may only make it stricter), as a pill. */
export function StatusBanner({ status }: { status: DecisionStatus }) {
  const { label, icon: Icon, tone, detail } = STATUS[status]
  return (
    <span role="status" data-status={status} className={`pill pill-${tone}`} title={detail}>
      <Icon size={14} strokeWidth={2} aria-hidden="true" />
      Status: {label}
    </span>
  )
}
