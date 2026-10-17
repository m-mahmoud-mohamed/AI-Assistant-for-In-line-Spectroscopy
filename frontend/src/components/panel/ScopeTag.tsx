import { BadgeCheck } from 'lucide-react'
import type { Scope, SourceRef } from '../../types'
import { SCOPE_INFO } from '../report/scope'
import './panel.css'

/** Scope label of an evidence card with its icon (the labels Lumeo shows beside a source). */
export function ScopeTag({ scope, source }: { scope: Scope; source?: Pick<SourceRef, 'verification'> }) {
  const { label, icon: Icon } = SCOPE_INFO[scope]
  const verified = source?.verification?.status === 'VERIFIED'
  return (
    <span className="sc-tag">
      <Icon size={13} strokeWidth={1.75} aria-hidden="true" />
      {label}
      {verified && (
        <span className="sc-verified">
          <BadgeCheck size={13} strokeWidth={1.75} aria-hidden="true" /> Verified
        </span>
      )}
    </span>
  )
}
