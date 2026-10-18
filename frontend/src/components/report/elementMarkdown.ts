// Copy helpers: a report block as Markdown text.
/** Preserve tables when a scientist pastes a section into a document or an e-mail. */
export function elementMarkdown(element: HTMLElement | null): string {
  if (!element) return ''
  const clone = element.cloneNode(true) as HTMLElement
  clone.querySelectorAll('[data-copy-ignore], [data-print-hide], .sr-only').forEach((node) => node.remove())
  clone.querySelectorAll('table').forEach((table) => {
    const rows = [...table.rows].map((row) => [...row.cells].map((cell) => (cell.textContent ?? '').trim().replaceAll('|', '\\|').replace(/\s+/g, ' ')))
    const lines = rows.map((cells) => `| ${cells.join(' | ')} |`)
    if (rows[0]) lines.splice(1, 0, `| ${rows[0].map(() => '---').join(' | ')} |`)
    table.replaceWith(document.createTextNode(`\n${lines.join('\n')}\n`))
  })
  clone.querySelectorAll('p, li, h3, h4, dt, dd').forEach((node) => node.append(document.createTextNode('\n')))
  return (clone.textContent ?? '').trim().replace(/\n{3,}/g, '\n\n')
}
