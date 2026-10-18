import { Fragment, type ReactNode } from 'react'
import { VERDICT_LABEL } from '../../labels'
import type { DocBlock, ReportDoc, ReportViewData } from '../../types'
import './print.css'

/** `**bold**` in a block's text. */
function inline(text: string): ReactNode {
  return text.split('**').map((part, i) => (i % 2 ? <strong key={i}>{part}</strong> : <Fragment key={i}>{part}</Fragment>))
}

function Block({ block: b }: { block: DocBlock }) {
  switch (b.kind) {
    case 'h': {
      const H = `h${Math.min(4, Math.max(2, b.level))}` as 'h2' | 'h3' | 'h4'
      return <H>{inline(b.text)}</H>
    }
    case 'p':
      return <p>{inline(b.text)}</p>
    case 'note':
      return <p className="print-note">{inline(b.text)}</p>
    case 'quote':
      return <blockquote>{b.text.split('\n').filter(Boolean).map((line, i) => <p key={i}>{line}</p>)}</blockquote>
    case 'box':
      return <div className="print-box"><strong>{b.title}.</strong> {inline(b.text)}</div>
    case 'ul':
    case 'ol': {
      const List = b.kind
      return <List>{b.items.map((item, i) => <li key={i}>{inline(item)}</li>)}</List>
    }
    case 'table':
      return (
        <table>
          <colgroup>{b.columns.map((_, i) => <col key={i} style={{ width: `${b.widths[i] ?? 100 / b.columns.length}%` }} />)}</colgroup>
          <thead><tr>{b.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>{b.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{inline(cell)}</td>)}</tr>)}</tbody>
        </table>
      )
    case 'figure':
      return (
        <figure>
          <img alt={b.title} src={`data:image/svg+xml;utf8,${encodeURIComponent(b.svg)}`} />
          <figcaption>{b.title}</figcaption>
        </figure>
      )
    default:
      return null
  }
}

/** The title, the enquiry and the answer from what the app already holds: stands in until the server's document arrives. */
function fallbackDoc(report: ReportViewData): ReportDoc {
  const text = (list: { text: string }[]) => list.map((s) => s.text).join(' ')
  const blank = { items: [], columns: [], rows: [], widths: [], level: 2, svg: '', title: '' }
  return {
    title: report.title || 'PRISM assessment',
    version: report.version_info?.version ?? 1,
    date: report.created_at?.slice(0, 10) ?? '',
    status: '',
    prepared_by: 'PRISM for Art Fiber Systems (AFS)',
    front: [
      { ...blank, kind: 'h', text: 'Original enquiry' },
      { ...blank, kind: 'quote', text: report.original_enquiry ?? '' },
      { ...blank, kind: 'h', text: 'Direct answer' },
      { ...blank, kind: 'p', text: `**${VERDICT_LABEL[report.direct_answer.verdict]}.** ${text(report.direct_answer.text)}` },
    ],
    sections: [],
    legend: [],
  }
}

interface ReportPrintDocumentProps {
  report: ReportViewData
  /** The server's document for the version on screen; until it arrives the title, enquiry and answer print from `report`. */
  doc?: ReportDoc
}

/**
 * The report as a document for the browser's print dialog, drawn from the server's document model (the one the PDF,
 * Markdown and JSON exports are made from), so the printed page has the same content and order. The report pane mounts
 * it only while printing; in print it replaces the app. Light colours and A4 margins come from print.css whatever the theme.
 */
export function ReportPrintDocument({ report, doc }: ReportPrintDocumentProps) {
  const d = doc ?? fallbackDoc(report)
  return (
    <article className="report-print" aria-label="Print assessment report">
      <h1>{d.title}</h1>
      <p className="print-meta">{[d.date, `Report v${d.version}`, d.status, d.prepared_by].filter(Boolean).join(' · ')}</p>
      {d.front.map((b, i) => <Block key={i} block={b} />)}
      {d.sections.map((s, n) => (
        <section key={s.id}>
          <h2>{['references', 'quality', 'conversation'].includes(s.id) ? s.title : `${n + 1} ${s.title}`}</h2>
          {s.blocks.map((b, i) => <Block key={i} block={b} />)}
        </section>
      ))}
      {d.legend.length > 0 && <p className="print-legend">Markers: {d.legend.join('; ')}.</p>}
    </article>
  )
}
