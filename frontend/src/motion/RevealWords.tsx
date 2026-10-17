import { Children, cloneElement, isValidElement, type CSSProperties, type ElementType, type ReactElement, type ReactNode } from 'react'
import { tokenize, wordDelay } from './words'

export interface RevealWordsProps {
  /** Plain text to reveal. Use `children` instead to keep inline markup (the emphasis words). */
  text?: string
  children?: ReactNode
  /** Delay before the first word, ms. */
  delay?: number
  /** Gap between consecutive words, ms. */
  stagger?: number
  /** Upper bound for the delay of the last word, ms (long paragraphs reveal in bounded time). */
  perWordCap?: number
  /** Duration of one word, ms. */
  duration?: number
  /** Start blur in px. */
  blur?: number
  /** Start offset (CSS length) the word rises from. */
  rise?: string
  /** Clip each word to its line box so words rise out of the line (the greeting). */
  mask?: boolean
  as?: ElementType
  className?: string
  id?: string
}

function countIn(node: ReactNode): number {
  if (typeof node === 'string' || typeof node === 'number') return tokenize(String(node)).filter((t) => !t.isSpace).length
  let n = 0
  Children.forEach(node, (child) => {
    if (typeof child === 'string' || typeof child === 'number') n += countIn(child)
    else if (isValidElement(child)) n += countIn((child.props as { children?: ReactNode }).children)
  })
  return n
}

/**
 * Word-by-word blur-up reveal. Every word is an inline-block span with its own animation delay
 * (CSS keyframes `word-in`); under `prefers-reduced-motion` the CSS shows the text at once.
 * Inline elements in `children` are kept and their words animate too. An element with `data-word-class="x"`
 * hands that class to each of its words (with `--gi`/`--gd` slice variables), so a gradient can span them.
 */
export function RevealWords({
  text,
  children,
  delay = 0,
  stagger = 55,
  perWordCap,
  duration = 450,
  blur = 6,
  rise,
  mask = false,
  as: Tag = 'span',
  className,
  id,
}: RevealWordsProps) {
  const content: ReactNode = text ?? children
  const total = countIn(content)
  let index = 0

  const wordStyle = (i: number): CSSProperties =>
    ({
      '--word-delay': `${delay + wordDelay(i, total, stagger, perWordCap)}ms`,
      '--word-dur': `${duration}ms`,
      '--blur': `${blur}px`,
      ...(rise ? { '--rise': rise } : {}),
    }) as CSSProperties

  interface Group {
    className: string
    n: number
    i: number
  }

  const render = (node: ReactNode, keyPrefix: string, group?: Group): ReactNode => {
    if (typeof node === 'string' || typeof node === 'number') {
      return tokenize(String(node)).map((tok, k) => {
        if (tok.isSpace) return <span key={`${keyPrefix}-${k}`} className="reveal-gap">{tok.text}</span>
        const style = wordStyle(index++) as CSSProperties & Record<string, string | number>
        if (group) {
          style['--gi'] = group.i
          style['--gd'] = Math.max(group.n - 1, 1)
          style['--gn'] = group.n
          group.i += 1
        }
        const word = (
          <span className={`reveal-word${group ? ` ${group.className}` : ''}`} style={style}>
            {tok.text}
          </span>
        )
        return mask ? (
          <span key={`${keyPrefix}-${k}`} className="reveal-mask">
            {word}
          </span>
        ) : (
          <span key={`${keyPrefix}-${k}`} style={{ display: 'inline-block' }}>
            {word}
          </span>
        )
      })
    }
    return Children.map(node, (child, i) => {
      if (typeof child === 'string' || typeof child === 'number') return render(child, `${keyPrefix}-${i}`, group)
      if (isValidElement(child)) {
        const el = child as ReactElement<{ children?: ReactNode; 'data-word-class'?: string }>
        const wordClass = el.props['data-word-class']
        const inner = wordClass ? { className: wordClass, n: countIn(el.props.children), i: 0 } : group
        return cloneElement(el, { key: `${keyPrefix}-${i}` }, render(el.props.children, `${keyPrefix}-${i}`, inner))
      }
      return child
    })
  }

  return (
    <Tag className={className} id={id}>
      {render(content, 'w')}
    </Tag>
  )
}
