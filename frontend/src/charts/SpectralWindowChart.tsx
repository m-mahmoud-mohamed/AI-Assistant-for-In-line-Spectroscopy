import { lazy, Suspense, useMemo } from 'react'
import { useChartColors } from '../hooks/useChartColors'
import { Ban, Loader2 } from 'lucide-react'
import type { Data, PlotMouseEvent } from 'plotly.js'
import type { Finding, SpectralData } from '../types'
import { buildSpectralTraces, formatRange } from './spectral'

// Plotly is large: load it (min bundle + react-plotly.js factory) only when the chart is shown.
const Plot = lazy(async () => {
  const [{ default: Plotly }, { default: createPlotlyComponent }] = await Promise.all([
    import('plotly.js-dist-min'),
    import('react-plotly.js/factory'),
  ])
  return { default: createPlotlyComponent(Plotly) }
})

interface SpectralWindowChartProps {
  data: SpectralData
  /** Candidate method IDs to show; all methods when empty. */
  methods?: string[]
  /** Fiber family ID of the client's existing fiber, if known. */
  clientFiber?: string | null
  findings?: Finding[]
  /** Opens an evidence card when a bar is clicked. */
  onCite?: (cardId: string) => void
}

/** Method vs. fiber vs. instrument ranges, with overlap (green) and blocking fiber-window gaps (red). */
export function SpectralWindowChart({ data, methods, clientFiber, findings, onCite }: SpectralWindowChartProps) {
  const colors = useChartColors()
  const fig = useMemo(
    () => buildSpectralTraces(data, { methods, clientFiber, findings }, colors),
    [data, methods, clientFiber, findings, colors],
  )

  // Narrow screens: fewer ticks so the labels do not collide.
  const narrow = typeof window !== 'undefined' && window.innerWidth < 520
  const layout = useMemo(() => {
    const x = fig.layout.xaxis
    if (!narrow || !x?.tickvals) return fig.layout
    const keep = [0, 2, 4].filter((i) => i < (x.tickvals as number[]).length)
    return {
      ...fig.layout,
      xaxis: { ...x, tickvals: keep.map((i) => (x.tickvals as number[])[i]), ticktext: keep.map((i) => (x.ticktext as string[])[i]), title: { text: 'Wavelength (µm, log) · wavenumber (cm⁻¹)', font: { size: 10 } } },
    }
  }, [fig.layout, narrow])

  const onClick = (e: Readonly<PlotMouseEvent>) => {
    const cards = String(e.points[0]?.customdata ?? '').split(' ').filter(Boolean)
    if (cards[0]) onCite?.(cards[0])
  }

  const ranges = fig.traces.flatMap((t) => t.hovertext.map((h, i) => ({ key: `${t.name}-${i}`, kind: t.name, text: h })))

  return (
    <figure aria-label="Spectral windows: method, fiber and instrument ranges" className="chart">
      <div className="chart-box">
        <Suspense
          fallback={
            <p className="chart-loading">
              <Loader2 size={14} aria-hidden="true" className="spin" /> Loading chart…
            </p>
          }
        >
          <Plot
            data={fig.traces as unknown as Data[]}
            layout={layout}
            config={{ displaylogo: false, responsive: true, displayModeBar: false }}
            useResizeHandler
            style={{ width: '100%' }}
            onClick={onClick}
          />
        </Suspense>
      </div>
      <figcaption className="chart-caption">
        {fig.gaps.map((g, i) => (
          <p key={i} className="chart-gap">
            <Ban size={14} aria-hidden="true" style={{ color: colors.gap }} />
            <span>
              <strong className="rs-strong">Fiber-window gap</strong>{' '}
              <span className="mono">{formatRange([g.from, g.to])}</span>{' '}
              <span className="rs-muted-inline">{g.message}</span>
            </span>
          </p>
        ))}
        <details className="chart-text">
          <summary>Ranges as text</summary>
          <ul className="mono">
            {ranges.map((r) => (
              <li key={r.key}>
                <span className="rs-muted-inline">{r.kind}:</span> {r.text}
              </li>
            ))}
          </ul>
        </details>
      </figcaption>
    </figure>
  )
}
