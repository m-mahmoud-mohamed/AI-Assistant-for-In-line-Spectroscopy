// Spectral range helpers for the ranges table: a unit conversion for display and a guard for the excitation field.

const RANGE = /^\s*([\d.,]+)\s*[–—-]\s*([\d.,]+)\s*(nm|µm|μm|um|cm⁻¹|cm-1|1\/cm)(?![a-z])/i

const num = (s: string) => Number(s.replaceAll(',', ''))
const fmt = (n: number) => Math.round(n).toLocaleString('en-US')

/**
 * The same range in the other unit family ("780–2500 nm" → "12,821–4,000 cm⁻¹"), or null when the text is not a plain
 * range. Raman ranges are not converted: a Raman shift is relative to the excitation line, not an absolute wavelength.
 */
export function alternateRange(method: string, nominal: string): string | null {
  if (/raman/i.test(method)) return null
  const m = RANGE.exec(nominal)
  if (!m) return null
  const [lo, hi] = [num(m[1]), num(m[2])]
  const unit = m[3].toLowerCase()
  if (!(lo > 0 && hi > 0)) return null
  if (unit === 'nm') return `${fmt(1e7 / lo)}–${fmt(1e7 / hi)} cm⁻¹`
  if (unit === 'µm' || unit === 'μm' || unit === 'um') return `${fmt(1e4 / lo)}–${fmt(1e4 / hi)} cm⁻¹`
  return `${fmt(1e7 / lo)}–${fmt(1e7 / hi)} nm`
}

/** The excitation wavelength as "785 nm" when the field holds one; anything else (free text) is not shown. */
export function excitationLabel(value: number | string | null): string | null {
  const m = value != null ? /^\s*(\d{3,4}(?:\.\d+)?)\s*(?:nm)?\s*$/i.exec(String(value)) : null
  return m ? `${m[1]} nm` : null
}
