import { Braces, Download, FileText, Mail, Printer } from 'lucide-react'
import { downloadJson, downloadMarkdown, printReport } from '../export'
import type { ReportViewData } from './report/ReportView'
import { Dropdown, type DropdownItem } from './shell/Dropdown'

interface ExportMenuProps {
  report: ReportViewData | null
  runId?: string | null
  onEmailDraft: () => void
  /** Button style: the top bar uses the default secondary button, the action bar the small one. */
  className?: string
  align?: 'left' | 'right'
  /** Class of the label span (the top bar hides it below 760 px). */
  labelClassName?: string
}

/** Markdown / JSON download, print to PDF and the customer e-mail draft. Disabled until a report exists. */
export function ExportMenu({ report, runId, onEmailDraft, className = 'btn', align = 'right', labelClassName }: ExportMenuProps) {
  const items: DropdownItem[] = report
    ? [
        { id: 'md', label: 'Download Markdown', icon: FileText, onSelect: () => void downloadMarkdown(report, runId) },
        { id: 'json', label: 'Download JSON', icon: Braces, onSelect: () => downloadJson(report) },
        { id: 'print', label: 'Print / save as PDF', icon: Printer, onSelect: printReport },
        { id: 'email', label: 'Customer e-mail draft', icon: Mail, onSelect: onEmailDraft },
      ]
    : []
  return (
    <Dropdown ariaLabel="Export" items={items} align={align} disabled={!report} className={className}>
      <Download size={16} strokeWidth={1.75} aria-hidden="true" />
      <span className={labelClassName}>Export</span>
    </Dropdown>
  )
}
