import { lazy, Suspense, useMemo } from 'react'
import { Ban, Loader2 } from 'lucide-react'
import type { Data, PlotMouseEvent } from 'plotly.js'
import type { Finding, SpectralData } from '../types'
import { buildSpectralTraces, COLORS, formatRange } from './spectral'

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
  const fig = useMemo(
    () => buildSpectralTraces(data, { methods, clientFiber, findings }),
    [data, methods, clientFiber, findings],
  )

  const onClick = (e: Readonly<PlotMouseEvent>) => {
    const cards = String(e.points[0]?.customdata ?? '').split(' ').filter(Boolean)
    if (cards[0]) onCite?.(cards[0])
  }

  const ranges = fig.traces.flatMap((t) => t.hovertext.map((h, i) => ({ key: `${t.name}-${i}`, kind: t.name, text: h })))

  return (
    <figure aria-label="Spectral windows: method, fiber and instrument ranges" className="flex flex-col gap-3">
      <div className="min-h-48 rounded-lg border border-line bg-surface p-2">
        <Suspense
          fallback={
            <p className="flex items-center gap-2 p-4 text-sm text-muted">
              <Loader2 size={14} aria-hidden="true" className="animate-spin" /> Loading chart…
            </p>
          }
        >
          <Plot
            data={fig.traces as unknown as Data[]}
            layout={fig.layout}
            config={{ displaylogo: false, responsive: true }}
            useResizeHandler
            style={{ width: '100%' }}
            onClick={onClick}
          />
        </Suspense>
      </div>
      <figcaption className="flex flex-col gap-2 text-sm">
        {fig.gaps.map((g, i) => (
          <p key={i} className="flex items-start gap-2 border-l-2 pl-3" style={{ borderColor: COLORS.gap }}>
            <Ban size={14} aria-hidden="true" className="mt-0.5 shrink-0" style={{ color: COLORS.gap }} />
            <span>
              <span className="font-semibold">Fiber-window gap</span>{' '}
              <span className="font-mono text-xs">
                {g.rule_id}: {formatRange([g.from, g.to])}
              </span>{' '}
              <span className="text-muted">{g.message}</span>
            </span>
          </p>
        ))}
        <details>
          <summary className="cursor-pointer text-xs text-muted">Ranges as text</summary>
          <ul className="mt-1 flex flex-col gap-0.5 font-mono text-xs">
            {ranges.map((r) => (
              <li key={r.key}>
                <span className="text-muted">{r.kind}:</span> {r.text}
              </li>
            ))}
          </ul>
        </details>
      </figcaption>
    </figure>
  )
}
