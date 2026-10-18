import type { DomainTier } from '../../types'

export const TIER_LABEL: Record<DomainTier, string> = {
  peer_reviewed: 'Peer-reviewed',
  standards: 'Standards body',
  vendor: 'Vendor',
  general: 'General web',
}

/** Provenance categories are independent of a website's trust tier. */
export const SOURCE_KIND_LABEL = {
  AFS: 'AFS knowledge base',
  UPLOAD: 'Uploaded document',
  WEB: 'Website',
  MCP: 'Imported through MCP',
  MCP_LIVE: 'Live MCP results',
} as const
