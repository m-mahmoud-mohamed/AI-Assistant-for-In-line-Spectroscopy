import type { DomainTier } from '../../types'

export const TIER_LABEL: Record<DomainTier, string> = {
  peer_reviewed: 'Peer-reviewed',
  standards: 'Standards body',
  vendor: 'Vendor',
  general: 'General web',
}
