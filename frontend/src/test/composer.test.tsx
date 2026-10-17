import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Composer } from '../components/composer/Composer'

function Harness({ onSubmit = () => {}, offline = false, busy = false, initial = '' }: { onSubmit?: (t: string) => void; offline?: boolean; busy?: boolean; initial?: string }) {
  const [value, setValue] = useState(initial)
  const [deep, setDeep] = useState(false)
  const [web, setWeb] = useState(false)
  return (
    <>
      <Composer value={value} onChange={setValue} onSubmit={onSubmit} placeholder="Paste a client enquiry…" deep={deep} onDeepChange={setDeep} web={web} onWebChange={setWeb} offline={offline} busy={busy} docked={false} />
      <output data-testid="flags">{`${deep}/${web}`}</output>
    </>
  )
}

const box = () => screen.getByRole('textbox', { name: 'Paste a client enquiry…' })

describe('Composer', () => {
  it('Enter sends the trimmed text, Shift+Enter does not', () => {
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} />)
    fireEvent.change(box(), { target: { value: '  Measure fat in milk  ' } })
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith('Measure fat in milk')
  })

  it('send is disabled when empty, offline or busy', () => {
    const { rerender } = render(<Harness />)
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    fireEvent.change(box(), { target: { value: 'text' } })
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
    rerender(<Harness offline initial="text" />)
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    rerender(<Harness busy initial="text" />)
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  it('does not send while offline even on Enter', () => {
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} offline initial="text" />)
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('Deep and Web are independent switches', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('switch', { name: 'Web' }))
    expect(screen.getByTestId('flags')).toHaveTextContent('false/true')
    fireEvent.click(screen.getByRole('switch', { name: 'Deep' }))
    expect(screen.getByTestId('flags')).toHaveTextContent('true/true')
  })

  it('attach reads a text file into the input', async () => {
    render(<Harness />)
    const file = new File(['Client enquiry from a file.'], 'enquiry.txt', { type: 'text/plain' })
    fireEvent.change(screen.getByTestId('composer-file'), { target: { files: [file] } })
    await waitFor(() => expect(box()).toHaveValue('Client enquiry from a file.'))
  })

  it('attach appends to existing text', async () => {
    render(<Harness initial="First part" />)
    fireEvent.change(screen.getByTestId('composer-file'), { target: { files: [new File(['Second part'], 'a.md')] } })
    await waitFor(() => expect(box()).toHaveValue('First part\n\nSecond part'))
  })
})
