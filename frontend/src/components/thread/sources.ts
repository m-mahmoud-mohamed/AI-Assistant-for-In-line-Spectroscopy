import type { SourceRef } from '../../types'

/** How many times each evidence card is cited in a report (walks every `evidence_ids` array). */
export function citationCounts(report: unknown): Record<string, number> {
  const counts: Record<string, number> = {}
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk)
    } else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'evidence_ids' && Array.isArray(value)) {
          for (const id of value) if (typeof id === 'string') counts[id] = (counts[id] ?? 0) + 1
        } else if (key !== 'sources') walk(value)
      }
    }
  }
  walk(report)
  return counts
}

/** Hostname of an external source, else null. */
export function sourceHost(source: Pick<SourceRef, 'url'>): string | null {
  if (!source.url) return null
  try {
    return new URL(source.url).host
  } catch {
    return source.url
  }
}

/** Most cited first (ties keep report order); used to pick the three source cards shown in the thread. */
export function rankSources(sources: SourceRef[], counts: Record<string, number>): SourceRef[] {
  return sources
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (counts[b.s.id] ?? 0) - (counts[a.s.id] ?? 0) || a.i - b.i)
    .map(({ s }) => s)
}

/** Scope in plain words for the source cards ("AFS lab study"); external sources show their domain instead. */
export const SCOPE_PLAIN: Record<SourceRef['scope'], string> = {
  method_general: 'AFS method',
  process_application: 'AFS app note',
  lab_study: 'AFS lab study',
  in_vitro_poc: 'AFS in-vitro',
  business_context: 'AFS business',
  external: 'Web source',
}

/** A web source whose deterministic checks all passed (scope `external`, `verification.status === 'VERIFIED'`). */
export const isVerifiedWeb = (source: Pick<SourceRef, 'scope' | 'verification'>): boolean =>
  source.scope === 'external' && source.verification?.status === 'VERIFIED'

/** Domain shown on a web source card: the verification's domain, else the URL's host. */
export const webDomain = (source: Pick<SourceRef, 'url' | 'verification'>): string | null =>
  source.verification?.domain || sourceHost(source)
