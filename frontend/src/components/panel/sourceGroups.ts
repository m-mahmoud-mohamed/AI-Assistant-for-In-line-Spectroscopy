import type { SourceRef } from '../../types'

export interface SourceGroup {
  key: string
  title: string
  sources: SourceRef[]
}

/** Titles of the five source documents (the filenames of the AFS materials). */
const DOC_TITLES: Record<string, string> = {
  S01: 'Multispectral laboratory',
  S02: 'AFS process-control slides',
  S03: 'LED kidney study (2017)',
  S04: 'Combined MIR and fluorescence (2021)',
  S05: 'AFS flyer',
}

/** The document a report source belongs to: S01…S05, the method table, web, or other. */
export function sourceDoc(s: Pick<SourceRef, 'id' | 'scope'>): string {
  if (s.id.startsWith('MCP_LIVE-')) return 'MCP_LIVE'
  if (s.id.startsWith('MCP-')) return 'MCP'
  if (s.id.startsWith('UPLOAD-')) return 'UPLOAD'
  if (s.id.startsWith('WEB-')) return 'WEBSITE'
  if (s.scope === 'external' || s.id.startsWith('EXT')) return 'WEB'
  if (s.id.startsWith('TABLE')) return 'TABLE'
  return /^S\d\d/.exec(s.id)?.[0] ?? 'OTHER'
}

const ORDER = ['S01', 'S02', 'S03', 'S04', 'S05', 'TABLE', 'UPLOAD', 'WEBSITE', 'MCP', 'MCP_LIVE', 'WEB', 'OTHER']

/** Report sources grouped by document in a stable order (S01…S05, Table 1, Web); empty groups are dropped. */
export function groupSources(sources: SourceRef[]): SourceGroup[] {
  const by = new Map<string, SourceRef[]>()
  for (const s of sources) {
    const key = sourceDoc(s)
    by.set(key, [...(by.get(key) ?? []), s])
  }
  return ORDER.filter((k) => by.has(k)).map((key) => ({
    key,
    title: ({ UPLOAD: 'Uploaded documents', WEBSITE: 'Websites', MCP: 'Imported through MCP', MCP_LIVE: 'Live MCP results' } as Record<string, string>)[key] ?? (key === 'TABLE' ? 'Table 1 · method comparison (S01)' : key === 'WEB' ? 'Web · verified sources' : key === 'OTHER' ? 'Other' : `${key} · ${DOC_TITLES[key] ?? ''}`.replace(/ · $/, '')),
    sources: by.get(key)!,
  }))
}
