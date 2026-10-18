import { BookOpen, Calculator, Cpu, FileText, GitCompare, Globe, Mail, Search, Wrench, type LucideIcon } from 'lucide-react'

export type ToolKind = 'web' | 'kb' | 'search' | 'calc' | 'engine' | 'report' | 'email' | 'compare' | 'other'

/** What a tool name is about: the web, the knowledge base, a calculator, the rules engine, the report, e-mail. */
export function toolKind(tool: string): ToolKind {
  const t = tool.toLowerCase()
  if (t.startsWith('web')) return 'web'
  if (t.startsWith('kb')) return 'kb'
  if (t.includes('search')) return 'search'
  if (t.startsWith('calc')) return 'calc'
  if (t.startsWith('engine') || t.startsWith('assess')) return 'engine'
  if (t.startsWith('report') || t.includes('write')) return 'report'
  if (t.includes('email') || t.includes('mail')) return 'email'
  if (t.includes('compare') || t.includes('diff')) return 'compare'
  return 'other'
}

export const TOOL_ICONS: Record<ToolKind, LucideIcon> = {
  web: Globe,
  kb: BookOpen,
  search: Search,
  calc: Calculator,
  engine: Cpu,
  report: FileText,
  email: Mail,
  compare: GitCompare,
  other: Wrench,
}
