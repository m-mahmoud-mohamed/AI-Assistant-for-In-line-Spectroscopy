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

/** A web source whose deterministic checks all passed (scope `external`, `verification.status === 'VERIFIED'`). */
export const isVerifiedWeb = (source: Pick<SourceRef, 'scope' | 'verification'>): boolean =>
  source.scope === 'external' && source.verification?.status === 'VERIFIED'

/** Domain shown on a web source card: the verification's domain, else the URL's host. */
export const webDomain = (source: Pick<SourceRef, 'url' | 'verification'>): string | null =>
  source.verification?.domain || sourceHost(source)

/** Citation labels for the cards a stored answer cites (stored messages keep only their text): the shown report's
 *  label when the report cites the card too, else one read from the id ("S01-p05-…" → "S01 p.5"). */
export function storedCitations(text: string, sources: { id: string; citation: string }[] = []): Record<string, string> {
  const labels = new Map(sources.map((s) => [s.id, s.citation]))
  const out: Record<string, string> = {}
  for (const [, id] of text.matchAll(/\[([A-Z][A-Za-z0-9_.-]+)\]/g)) {
    const page = /^(S0\d)-p0*(\d+)-/.exec(id)
    const label = labels.get(id) ?? (page ? `${page[1]} p.${page[2]}` : id.startsWith('TABLE-') ? 'S01 Table 1' : undefined)
    if (label) out[id] = label
  }
  return out
}
