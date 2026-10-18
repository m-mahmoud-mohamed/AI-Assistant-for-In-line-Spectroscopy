import { useId, useState, type ReactNode } from 'react'
import { ChevronDown, CircleAlert, Loader2 } from 'lucide-react'
import { toolLabel } from '../../assistant/format'
import type { ToolRun } from '../../assistant/turnReducer'
import { TOOL_ICONS, toolKind } from './toolIcons'

interface ToolRowProps {
  tool: ToolRun
  /** Extra detail shown when the row opens (the report run's stages). */
  children?: ReactNode
}

/** One line of tool activity: icon, what it did, what it found (muted); opens to the details. */
export function ToolRow({ tool, children }: ToolRowProps) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const Icon = TOOL_ICONS[toolKind(tool.tool)]
  const expandable = !!(tool.summary || children)
  const glyph =
    tool.status === 'running' ? (
      <Loader2 size={15} strokeWidth={2} className="spin as-tool-run" aria-hidden="true" />
    ) : tool.status === 'failed' ? (
      <CircleAlert size={15} strokeWidth={1.75} className="as-tool-bad" aria-hidden="true" />
    ) : (
      <Icon size={15} strokeWidth={1.75} aria-hidden="true" />
    )
  const head = (
    <>
      <span className="as-tool-icon">{glyph}</span>
      <span className="as-tool-text">
        <span className="as-tool-label">{toolLabel(tool.tool, tool.label)}</span>
        {tool.summary && <span className="as-tool-sum"> · {tool.summary}</span>}
      </span>
      {expandable && <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" data-open={open} className="as-tool-chev" />}
    </>
  )
  return (
    <li className="as-tool" data-status={tool.status}>
      {expandable ? (
        <button type="button" className="as-tool-head" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
          {head}
        </button>
      ) : (
        <div className="as-tool-head">{head}</div>
      )}
      <div className="as-tool-body" id={id} data-open={open} hidden={!open}>
        <div className="as-tool-detail">
          <dl className="as-tool-meta">
            {tool.summary && (
              <>
                <dt>Result</dt>
                <dd>{tool.summary}</dd>
              </>
            )}
          </dl>
          {children}
        </div>
      </div>
    </li>
  )
}

/** Consecutive tool calls as a quiet list of one-line rows. */
export function ToolActivity({ tools }: { tools: ToolRun[] }) {
  if (tools.length === 0) return null
  return (
    <ul className="as-tools" aria-label="Tool activity">
      {tools.map((t) => (
        <ToolRow key={t.callId} tool={t} />
      ))}
    </ul>
  )
}
