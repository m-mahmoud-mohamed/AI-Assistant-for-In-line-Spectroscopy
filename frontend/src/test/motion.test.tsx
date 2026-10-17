import { act, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BlurIn, Orb, RevealWords, Skeleton, flipDelta, playFlip, typedSlice, useTypewriter } from '../motion'
import { countWords, dayPart, greetingFor, tokenize, wordDelay } from '../motion/words'

describe('words', () => {
  it('tokenize keeps words and whitespace so text rebuilds exactly', () => {
    const toks = tokenize('Good  afternoon.\nWhich')
    expect(toks.map((t) => t.text).join('')).toBe('Good  afternoon.\nWhich')
    expect(toks.filter((t) => !t.isSpace).map((t) => t.text)).toEqual(['Good', 'afternoon.', 'Which'])
    expect(countWords('  a b  c ')).toBe(3)
    expect(countWords('')).toBe(0)
  })

  it('wordDelay staggers and caps the last word', () => {
    expect(wordDelay(0, 5, 55)).toBe(0)
    expect(wordDelay(3, 5, 55)).toBe(165)
    // 101 words at 30 ms would end at 3000 ms; the cap holds the last word at 900 ms
    expect(wordDelay(100, 101, 30, 900)).toBe(900)
    expect(wordDelay(50, 101, 30, 900)).toBe(450)
    expect(wordDelay(0, 1, 55, 100)).toBe(0)
  })

  it('greeting follows the time of day', () => {
    const at = (h: number) => new Date(2026, 9, 17, h, 0)
    expect(dayPart(at(6))).toBe('morning')
    expect(dayPart(at(12))).toBe('afternoon')
    expect(dayPart(at(17))).toBe('afternoon')
    expect(dayPart(at(18))).toBe('evening')
    expect(dayPart(at(23))).toBe('evening')
    expect(greetingFor(at(9))).toBe('Good morning.')
  })
})

describe('typewriter', () => {
  afterEach(() => vi.useRealTimers())

  it('typedSlice follows elapsed time', () => {
    expect(typedSlice('Hello', 0, 28)).toBe('')
    expect(typedSlice('Hello', 56, 28)).toBe('He')
    expect(typedSlice('Hello', 10_000, 28)).toBe('Hello')
    expect(typedSlice('Hello', 10, 0)).toBe('Hello')
  })

  it('types the text in and restarts when it changes', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ text }) => useTypewriter(text, 20), { initialProps: { text: 'Dairy line' } })
    expect(result.current).toBe('')
    act(() => void vi.advanceTimersByTime(60))
    expect(result.current.length).toBeGreaterThan(0)
    expect('Dairy line'.startsWith(result.current)).toBe(true)
    act(() => void vi.advanceTimersByTime(1000))
    expect(result.current).toBe('Dairy line')
    rerender({ text: 'Milk' })
    expect(result.current).toBe('')
    act(() => void vi.advanceTimersByTime(1000))
    expect(result.current).toBe('Milk')
  })
})

describe('flip', () => {
  it('flipDelta is the translation back to the first position', () => {
    expect(flipDelta({ left: 100, top: 400, width: 600, height: 50 }, { left: 40, top: 800, width: 600, height: 50 })).toEqual({ dx: 60, dy: -400 })
  })

  it('playFlip animates with WAAPI and skips when nothing moves or motion is reduced', () => {
    const animate = vi.fn(() => ({}) as Animation)
    const el = { animate } as unknown as HTMLElement
    const r = (left: number, top: number) => ({ left, top, width: 10, height: 10 })
    expect(playFlip(el, r(0, 0), r(0, 300), { duration: 520 })).not.toBeNull()
    expect(animate).toHaveBeenCalledWith(
      [{ transform: 'translate(0px, -300px)' }, { transform: 'translate(0, 0)' }],
      expect.objectContaining({ duration: 520, fill: 'backwards' }),
    )
    animate.mockClear()
    expect(playFlip(el, r(0, 0), r(0, 0))).toBeNull()
    expect(playFlip(el, r(0, 0), r(0, 300), { reduced: true })).toBeNull()
    expect(playFlip({} as HTMLElement, r(0, 0), r(0, 300))).toBeNull()
    expect(animate).not.toHaveBeenCalled()
  })
})

describe('components', () => {
  it('RevealWords wraps each word, keeps the text and inline markup, and sets staggered delays', () => {
    render(
      <p data-testid="p">
        <RevealWords delay={100} stagger={50}>
          Which process <b data-word-class="emph-word">look inside?</b>
        </RevealWords>
      </p>,
    )
    const p = screen.getByTestId('p')
    expect(p.textContent).toBe('Which process look inside?')
    const words = [...p.querySelectorAll<HTMLElement>('.reveal-word')]
    expect(words.map((w) => w.textContent)).toEqual(['Which', 'process', 'look', 'inside?'])
    expect(words.map((w) => w.style.getPropertyValue('--word-delay'))).toEqual(['100ms', '150ms', '200ms', '250ms'])
    expect(p.querySelector('b')).not.toBeNull()
    expect(words[2]).toHaveClass('emph-word')
    expect(words[3].style.getPropertyValue('--gi')).toBe('1')
  })

  it('RevealWords accepts plain text and the mask option', () => {
    render(<RevealWords text="Good evening." mask className="x" />)
    expect(document.querySelectorAll('.reveal-mask')).toHaveLength(2)
  })

  it('BlurIn carries its entrance variables; Orb and Skeleton are decorative', () => {
    render(
      <>
        <BlurIn delay={80} duration={420} y={24} blur={4}>
          <span>bubble</span>
        </BlurIn>
        <Orb size={72} breathe enter />
        <Skeleton height={20} />
      </>,
    )
    const el = screen.getByText('bubble').parentElement!
    expect(el).toHaveClass('blur-in')
    expect(el.style.getPropertyValue('--bi-delay')).toBe('80ms')
    expect(el.style.getPropertyValue('--bi-y')).toBe('24px')
    expect(document.querySelector('.orb-wrap')).toHaveAttribute('aria-hidden', 'true')
    expect(document.querySelector('.skeleton')).not.toBeNull()
  })
})
