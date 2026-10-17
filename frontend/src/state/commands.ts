import { Braces, FilePlus, FileText, FolderOpen, History, Mail, Printer, RotateCw } from 'lucide-react'
import type { Command } from '../components/CommandPalette'
import { downloadJson, downloadMarkdown, printReport } from '../export'
import { sessionTitle, sortSessions } from '../sessions'
import type { Assessment } from './useAssessment'

/** Entries of the ⌘K palette: new enquiry, history, the user's own sessions, report exports. No example cases. */
export function buildCommands(a: Assessment): Command[] {
  const { report, activeRunId } = a
  return [
    { id: 'new', group: 'Enquiry', label: 'New enquiry', icon: FilePlus, run: () => a.newEnquiry() },
    { id: 'history', group: 'Go to', label: 'History', icon: History, run: a.openHistory },
    ...sortSessions(a.sessionList).map((s) => ({
      id: `open-${s.id}`,
      group: 'Open assessment',
      label: sessionTitle(s),
      keywords: 'open session assessment',
      icon: FolderOpen,
      run: () => a.openSession(s.id),
    })),
    ...(report
      ? [
          { id: 'rerun', group: 'Run', label: 'Re-run in deep mode', icon: RotateCw, run: () => void a.rerun(true) },
          { id: 'md', group: 'Export', label: 'Download Markdown', icon: FileText, run: () => void downloadMarkdown(report, activeRunId) },
          { id: 'json', group: 'Export', label: 'Download JSON', icon: Braces, run: () => downloadJson(report) },
          { id: 'print', group: 'Export', label: 'Print / save as PDF', icon: Printer, run: printReport },
          { id: 'email', group: 'Export', label: 'Customer e-mail draft', icon: Mail, run: () => a.setEmailOpen(true) },
        ]
      : []),
  ]
}
