import { useEffect, useState } from 'react'
import { COLORS } from '../charts/spectral'

/** Plotly accepts resolved colours rather than CSS variables. Re-read tokens when appearance changes. */
export function useChartColors() {
  const read = () => {
    const style = getComputedStyle(document.documentElement)
    const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
    return {
      method: token('--violet', COLORS.method), fiber: token('--chart-fiber', COLORS.fiber),
      client: token('--ink', COLORS.client), instrument: token('--chart-neutral', COLORS.instrument),
      overlap: token('--status-ok', COLORS.overlap), gap: token('--status-bad', COLORS.gap),
      ink: token('--ink', COLORS.ink), body: token('--body', COLORS.body),
      grid: token('--hairline', COLORS.grid), line: token('--hairline-strong', COLORS.line),
      paper: token('--card', '#ffffff'),
    }
  }
  const [colors, setColors] = useState(read)
  useEffect(() => {
    const observer = new MutationObserver(() => setColors(read()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return colors
}
