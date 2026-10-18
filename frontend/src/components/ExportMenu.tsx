import { Braces, Download, FileDown, FileText, Mail, Printer } from 'lucide-react'
import { type ExportOptions, downloadJson, downloadMarkdown, downloadPdf, printReport } from '../export'
import type { ReportViewData } from '../types'
import { Dropdown, type DropdownItem } from './shell/Dropdown'

interface ExportMenuProps {
  report: ReportViewData | null
  options?: ExportOptions
  onToggleConversation?: () => void
  onToggleTechnical?: () => void
  /** The run of the version on screen: every export is that version. */
  runId?: string | null
  /** Only where no separate e-mail action is shown next to the menu. */
  onEmailDraft?: () => void
  /** Button style: the top bar uses the default secondary button, the action bar the small one. */
  className?: string
  align?: 'left' | 'right'
  /** Class of the label span (the top bar hides it below 760 px). */
  labelClassName?: string
}

/**
 * The one export entry point: the PDF (A4, built by the server), Markdown, JSON, the browser's print dialog, the two
 * optional appendices and the customer e-mail draft. Disabled until a report exists. Every file is the version on screen.
 */
export function ExportMenu({ report, runId, onEmailDraft, className = 'btn', align = 'right', labelClassName, options = {}, onToggleConversation, onToggleTechnical }: ExportMenuProps) {
  const version = report?.version_info?.version
  const items: DropdownItem[] = report
    ? [
        {
          id: 'pdf',
          label: version ? `Download PDF (v${version})` : 'Download PDF',
          icon: FileDown,
          // without a server the browser print dialog stands in
          onSelect: () => void downloadPdf(report, runId, options).then((ok) => ok || printReport()),
        },
        { id: 'md', label: 'Download Markdown', icon: FileText, onSelect: () => void downloadMarkdown(report, runId, options) },
        { id: 'json', label: 'Download JSON', icon: Braces, onSelect: () => void downloadJson(report, runId, options) },
        { id: 'print', label: 'Print…', icon: Printer, onSelect: printReport },
        ...(onToggleConversation ? [{ id: 'appendix-conversation', label: 'Include conversation appendix', checked: !!options.includeConversation, separatorBefore: true, onSelect: onToggleConversation }] : []),
        ...(onToggleTechnical ? [{ id: 'appendix-technical', label: 'Include technical appendix', checked: !!options.includeTechnical, onSelect: onToggleTechnical }] : []),
        ...(onEmailDraft ? [{ id: 'email', label: 'Customer e-mail draft', icon: Mail, separatorBefore: true, onSelect: onEmailDraft }] : []),
      ]
    : []
  return (
    <Dropdown ariaLabel="Export" items={items} align={align} disabled={!report} className={className}>
      <Download size={16} strokeWidth={1.75} aria-hidden="true" />
      <span className={labelClassName}>Export</span>
    </Dropdown>
  )
}
