import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Check, CircleHelp } from 'lucide-react'
import {
  choiceToAnswer,
  completeAnswers,
  EMPTY_CHOICE,
  nextChoice,
  optionKeys,
  OTHER_KEY,
  UNKNOWN_KEY,
  type Choice,
} from '../../assistant/answers'
import { describeAnswer, NOT_KNOWN_LABEL, OTHER_LABEL } from '../../assistant/format'
import type { ClarifyQuestion, EnginePreview, QuestionAnswer } from '../../types'
import { VerdictPreview } from './VerdictPreview'

interface QuestionCardProps {
  title: string
  questions: ClarifyQuestion[]
  /** The engine's verdict so far (`verdict` events). */
  verdict: EnginePreview | null
  /** Answered: the card shows what was applied and takes no input. */
  resolved?: boolean
  /** What this client submitted (absent when the answer came from elsewhere). */
  answers?: Record<string, QuestionAnswer>
  /** An answer is on its way to the server. */
  busy?: boolean
  error?: string | null
  /** Take the keyboard when the card appears (the turn is paused on it). */
  autoFocus?: boolean
  /** Every question answered: a value, several, "unknown" or text. Questions left open are sent as unknown. */
  onApply: (answers: Record<string, QuestionAnswer>) => void
  /** Skip all: every question is left unknown and goes to the report as a question for the client. */
  onSkip: () => void
}


/**
 * The clarify gate's question card: 1 to 3 questions with clickable options, each showing what it would change
 * (the engine's what-if). "Not known yet" and "Other…" are always there. Keyboard as in Claude Code: ↑/↓ move,
 * 1 to 9 pick, Enter applies, Esc skips. A live verdict preview sits on top.
 */
export function QuestionCard({ title, questions, verdict, resolved = false, answers, busy = false, error, autoFocus = false, onApply, onSkip }: QuestionCardProps) {
  const uid = useId()
  const [picks, setPicks] = useState<Record<string, Choice>>({})
  const [focusInput, setFocusInput] = useState<{ qid: string; n: number } | null>(null)
  const rootRef = useRef<HTMLElement>(null)
  const inputs = useRef<Record<string, HTMLInputElement | null>>({})
  const locked = resolved || busy

  const answerFor = (q: ClarifyQuestion) => choiceToAnswer(q, picks[q.id])
  const answered = questions.filter((q) => answerFor(q) !== null).length
  const canApply = answered > 0 && !locked

  const effects = useMemo(() => {
    const out: string[] = []
    for (const q of questions) {
      const pick = picks[q.id]
      if (!pick) continue
      for (const v of pick.values) {
        const effect = q.options.find((o) => o.value === v)?.effect
        if (effect) out.push(effect)
      }
    }
    return out
  }, [questions, picks])

  // The turn is paused on this card: take the keyboard, unless the scientist is typing something.
  useEffect(() => {
    if (!autoFocus || resolved) return
    const active = document.activeElement
    if (active && active !== document.body && !(active instanceof HTMLTextAreaElement && active.value === '')) return
    rootRef.current?.querySelector<HTMLElement>('[role="radio"]')?.focus({ preventScroll: true })
  }, [autoFocus, resolved]) // when the card appears

  useEffect(() => {
    if (focusInput) inputs.current[focusInput.qid]?.focus()
  }, [focusInput])

  const choose = (q: ClarifyQuestion, key: string) => {
    setPicks((all) => ({ ...all, [q.id]: nextChoice(q, all[q.id], key) }))
    if (key === OTHER_KEY) setFocusInput((f) => ({ qid: q.id, n: (f?.n ?? 0) + 1 }))
  }

  const isChecked = (q: ClarifyQuestion, key: string) => {
    const p = picks[q.id]
    if (!p) return false
    return key === UNKNOWN_KEY ? p.unknown : key === OTHER_KEY ? p.other : p.values.includes(key)
  }

  const groupOf = (el: Element | null): ClarifyQuestion | undefined => {
    const id = el?.closest('[data-qgroup]')?.getAttribute('data-qgroup')
    return questions.find((q) => q.id === id)
  }

  const optionButtons = (q: ClarifyQuestion) =>
    [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-qgroup]') ?? [])]
      .filter((g) => g.getAttribute('data-qgroup') === q.id)
      .flatMap((g) => [...g.querySelectorAll<HTMLElement>('[role="radio"], [role="checkbox"]')])

  /** Send the answers: what is picked, and "not known yet" for what is not (nothing is left unsaid). */
  const apply = (over?: { q: ClarifyQuestion; key: string }) => {
    const chosen = over ? { ...picks, [over.q.id]: nextChoice(over.q, picks[over.q.id], over.key) } : picks
    if (!locked && questions.some((q) => choiceToAnswer(q, chosen[q.id]) !== null)) onApply(completeAnswers(questions, chosen))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (locked || e.nativeEvent.isComposing) return
    const target = e.target as HTMLElement
    const inInput = target.tagName === 'INPUT'
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      const q = groupOf(target)
      if (inInput && q) optionButtons(q)[optionKeys(q).indexOf(OTHER_KEY)]?.focus() // leave the text first; a second Esc skips
      else onSkip()
      return
    }
    if (target.closest('[data-card-action]')) return // the Skip / Apply buttons act on their own keys
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      e.stopPropagation()
      // Enter on an option nothing was picked for yet picks it, then applies
      const here = groupOf(target)
      const index = here ? optionButtons(here).indexOf(target) : -1
      apply(here && !inInput && index >= 0 && !answerFor(here) ? { q: here, key: optionKeys(here)[index] } : undefined)
      return
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const q = groupOf(target) ?? questions.find((x) => !answerFor(x)) ?? questions[0]
    if (!q) return
    const keys = optionKeys(q)
    const buttons = optionButtons(q)
    const at = Math.max(0, buttons.findIndex((b) => b === target))

    const move = (to: number) => {
      const i = (to + keys.length) % keys.length
      buttons[i]?.focus()
      if (!q.multi) choose(q, keys[i])
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || (!inInput && (e.key === 'ArrowRight' || e.key === 'ArrowLeft'))) {
      e.preventDefault()
      e.stopPropagation()
      const dir = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1
      const from = inInput ? keys.indexOf(OTHER_KEY) : at
      move(from + dir)
      return
    }
    if (!inInput && /^[1-9]$/.test(e.key)) {
      const i = Number(e.key) - 1
      if (i < keys.length) {
        e.preventDefault()
        e.stopPropagation() // the number keys switch report tabs elsewhere
        buttons[i]?.focus()
        choose(q, keys[i])
      }
    }
  }

  // ------------------------------------------------------------ answered: a summary, no input
  if (resolved) {
    const skipped = answers && questions.every((q) => answers[q.id] && 'unknown' in answers[q.id])
    return (
      <section className="as-card as-question" aria-label={title || 'Questions'} data-resolved="true">
        <header className="as-q-head">
          <Check size={16} strokeWidth={2} className="as-ok" aria-hidden="true" />
          <h3 className="as-card-title">{skipped ? 'Questions skipped' : answers ? 'Answers applied' : 'Questions answered'}</h3>
        </header>
        <dl className="as-q-summary">
          {questions.map((q) => (
            <div key={q.id} className="as-q-sum-row">
              <dt>{q.text}</dt>
              <dd>{answers ? describeAnswer(q, answers[q.id]) : 'Answered'}</dd>
            </div>
          ))}
        </dl>
      </section>
    )
  }

  return (
    <section ref={rootRef} data-awaiting="true" className="as-card as-question" aria-label={title || 'Questions'} onKeyDown={onKeyDown} aria-busy={busy || undefined}>
      <header className="as-q-head">
        <CircleHelp size={16} strokeWidth={1.75} aria-hidden="true" />
        <h3 className="as-card-title">{title || (questions.length === 1 ? '1 question that changes the recommendation' : `${questions.length} questions that change the recommendation`)}</h3>
      </header>
      <VerdictPreview verdict={verdict} effects={effects} />
      <div className="as-q-list">
        {questions.map((q) => {
          const keys = optionKeys(q)
          const own = q.options.length
          const pick = picks[q.id]
          const tabbable = keys.findIndex((k) => isChecked(q, k))
          const textId = `${uid}-${q.id}`
          const renderOption = (key: string, i: number) => {
            const option = q.options.find((o) => o.value === key)
            const label = key === UNKNOWN_KEY ? NOT_KNOWN_LABEL : key === OTHER_KEY ? OTHER_LABEL : (option?.label ?? key)
            const checked = isChecked(q, key)
            return (
              <div key={key} className="as-opt-row" data-checked={checked || undefined}>
                <button
                  type="button"
                  role={q.multi ? 'checkbox' : 'radio'}
                  aria-checked={checked}
                  tabIndex={(tabbable < 0 ? i === 0 : i === tabbable) ? 0 : -1}
                  className="as-opt"
                  disabled={busy}
                  onClick={() => choose(q, key)}
                >
                  <span className="as-opt-mark" data-multi={q.multi || undefined} aria-hidden="true">
                    {q.multi && checked && (
                      <svg viewBox="0 0 12 12" width="12" height="12" fill="none">
                        <path d="M2.6 6.3 5 8.6l4.4-5" stroke="var(--switch-thumb)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                  <span className="as-opt-text">
                    <span className="as-opt-label">{label}</span>
                    {option?.effect && <span className="as-opt-effect">{option.effect}</span>}
                  </span>
                  {i < 9 && (
                    <kbd className="as-opt-key" aria-hidden="true">
                      {i + 1}
                    </kbd>
                  )}
                </button>
              </div>
            )
          }
          return (
            <div key={q.id} className="as-q">
              <p className="as-q-text" id={textId}>
                {q.text}
              </p>
              {q.why && <p className="as-q-why">{q.why}</p>}
              <div className="as-opts" role={q.multi ? 'group' : 'radiogroup'} aria-labelledby={textId} data-qgroup={q.id}>
                {keys.slice(0, own).map((key, i) => renderOption(key, i))}
                <div className="as-meta-opts">{keys.slice(own).map((key, i) => renderOption(key, own + i))}</div>
                {pick?.other && (
                  <input
                    ref={(el) => {
                      inputs.current[q.id] = el
                    }}
                    type="text"
                    className="as-other"
                    aria-label={`${q.text} — your answer`}
                    placeholder="Type the answer"
                    value={pick.otherText}
                    maxLength={200}
                    disabled={busy}
                    onChange={(e) => setPicks((all) => ({ ...all, [q.id]: { ...(all[q.id] ?? EMPTY_CHOICE), other: true, otherText: e.target.value } }))}
                  />
                )}
              </div>
            </div>
          )
        })}
      </div>
      {error && (
        <p role="alert" className="inline-error as-q-error">
          {error}
        </p>
      )}
      <footer className="as-q-foot">
        <p className="as-hints" aria-hidden="true">
          <kbd className="kbd">↑↓</kbd> move <kbd className="kbd">1–9</kbd> pick <kbd className="kbd">Enter</kbd> apply <kbd className="kbd">Esc</kbd> skip
        </p>
        <div className="as-actions">
          <button type="button" className="btn btn-sm" data-card-action onClick={onSkip} disabled={busy}>
            Skip
          </button>
          <button type="button" className="btn btn-sm btn-primary" data-card-action onClick={() => apply()} disabled={!canApply}>
            Apply answers
          </button>
        </div>
      </footer>
    </section>
  )
}
