import { Fragment, type ReactNode } from 'react'
import { Cite } from '../report/ClaimText'
import { WebSourceChip } from '../thread/FollowUps'
import type { ChatWebSource } from '../../types'

interface AssistantMessageProps {
  text: string
  /** Still arriving: the region is busy and not announced until it is whole. */
  streaming?: boolean
  /** Card id → display citation (`S01 p.14`), from `turn_completed`. */
  citations?: Record<string, string>
  onCite?: (cardId: string) => void
  webSources?: ChatWebSource[]
}

// `**bold**`, `code`, and a card id in brackets: [S01-p14-nir-range] or [[S01-p14-nir-range]]
const INLINE = /\*\*([^*]+)\*\*|`([^`]+)`|\[\[([^\]\s]+)\]\]|\[([^\]\s]+)\]/g

function inline(text: string, citations: Record<string, string>, used: Set<string>, onCite?: (id: string) => void): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0
    const id = m[3] ?? m[4]
    if (id !== undefined && !(id in citations)) continue // brackets that are not a citation stay as written
    if (at > last) out.push(text.slice(last, at))
    if (m[1] !== undefined) out.push(<strong key={at}>{m[1]}</strong>)
    else if (m[2] !== undefined) out.push(<code key={at}>{m[2]}</code>)
    else {
      used.add(id)
      out.push(<Cite key={at} id={id} label={citations[id]} onCite={onCite} />)
    }
    last = at + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const BULLET = /^\s*(?:[-*]|\d+[.)])\s+/

/**
 * The assistant's words: paragraphs, bullet lists, bold and code, with citation chips where the text names a card
 * (clicking one opens the Evidence tab) and the cards it cites but does not name listed under it, then verified web sources.
 */
export function AssistantMessage({ text, streaming = false, citations = {}, onCite, webSources = [] }: AssistantMessageProps) {
  const used = new Set<string>()
  const blocks = text.split(/\n{2,}/).filter((b) => b.trim())
  const body = blocks.map((block, i) => {
    const lines = block.split('\n')
    if (lines.every((l) => BULLET.test(l))) {
      const ordered = /^\s*\d/.test(lines[0])
      const List = ordered ? 'ol' : 'ul'
      return (
        <List key={i} className="as-list">
          {lines.map((l, k) => (
            <li key={k}>{inline(l.replace(BULLET, ''), citations, used, onCite)}</li>
          ))}
        </List>
      )
    }
    return (
      <p key={i} className="rs-p">
        {lines.map((l, k) => (
          <Fragment key={k}>
            {k > 0 && <br />}
            {inline(l, citations, used, onCite)}
          </Fragment>
        ))}
      </p>
    )
  })
  const rest = Object.keys(citations).filter((id) => !used.has(id))
  return (
    <div className="as-msg assistant-text rs" aria-live={streaming ? 'off' : 'polite'} aria-busy={streaming || undefined} data-streaming={streaming || undefined}>
      {body}
      {(!streaming && rest.length > 0) || webSources.length > 0 ? (
        <div className="answer-sources">
          {!streaming && rest.map((id) => <Cite key={id} id={id} label={citations[id]} onCite={onCite} />)}
          {webSources.map((w) => (
            <WebSourceChip key={w.url} source={w} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
