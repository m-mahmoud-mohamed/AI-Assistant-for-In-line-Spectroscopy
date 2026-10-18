// Human titles for evidence cards: the slide code ("S01 p.14") is a citation, not a name.
import type { SourceRef } from './types'

/** The fields of a card or report source the title is derived from (a `SourceRef` or an API `Card`). */
export interface TitleSource {
  id: string
  citation?: string
  quote?: string | null
  claim?: string | null
  /** A page title, when the source has one (web cards). */
  title?: string | null
  url?: string | null
  verification?: Pick<NonNullable<SourceRef['verification']>, 'domain'> | null
}

const ACRONYMS = new Set(['nir', 'mir', 'ir', 'uv', 'vis', 'led', 'api', 'pat', 'ftir', 'atr', 'nmr', 'afs', 'pca', 'pls', 'od', 'ph', 'sers', 'ccd', 'lod', 'gmp'])

const host = (url: string | null | undefined): string | null => {
  if (!url) return null
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** "blend-potency" / "nir_diffuse_reflection_probe" → "Blend potency" / "NIR diffuse reflection probe"; repeated words collapse. */
function readSlug(slug: string): string {
  const words = slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .filter((w, i, all) => i === 0 || w.toLowerCase() !== all[i - 1].toLowerCase())
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.toLowerCase()))
  const text = words.join(' ')
  return text ? text[0].toUpperCase() + text.slice(1) : ''
}

/** A short form of a sentence: its first words, ending in an ellipsis when cut. */
export function shortText(text: string, words = 6): string {
  const parts = text.replaceAll(/["“”]/g, '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return ''
  const cut = parts.slice(0, words).join(' ').replace(/[,;:.\s]+$/, '')
  const out = parts.length > words ? `${cut}…` : cut
  return out[0].toUpperCase() + out.slice(1)
}

/**
 * The topic of an evidence card in plain words, from its id slug (`S01-p14-blend-potency` → "Blend potency",
 * `TABLE-nir_diffuse_reflection_probe` → "NIR diffuse reflection probe"). Web cards (`EXT-…`) use the page title,
 * else the domain. Falls back to a short form of the claim or quote, then the citation.
 */
export function sourceTitle(s: TitleSource): string {
  if (/^(UPLOAD|MCP|MCP_LIVE)-/.test(s.id)) {
    return s.title?.trim() || s.citation?.replace(/^(Uploaded|Imported through MCP|Live MCP result): /, '').replace(/ p\.\d+$/, '') || 'Imported document'
  }
  if (s.id.startsWith('WEB-')) return s.title?.trim() || host(s.url) || s.citation || 'Website'
  if (s.id.startsWith('EXT')) {
    return s.title?.trim() || s.verification?.domain || host(s.url) || s.citation || 'Web source'
  }
  const slug = s.id.replace(/^(S\d\d|TABLE)[-_]?/i, '').replace(/^p\d+[-_]?/i, '')
  const fromSlug = readSlug(slug)
  if (fromSlug) return fromSlug
  const fromText = shortText(s.claim || s.quote || '')
  return fromText || s.citation || s.id
}
