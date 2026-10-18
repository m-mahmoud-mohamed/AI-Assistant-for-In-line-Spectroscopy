// App shell: URL routing and history, the resizable split, appearance, voice input and copy.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantMessage } from '../components/assistant/AssistantMessage'
import { Composer } from '../components/composer/Composer'
import { readRoute } from '../state/navigation'
import { FakeEventSource, detail, renderApp, routeFetch } from './helpers'
import mockSpectral from './fixtures/spectral.json'
import mockReport from './fixtures/report.json'
import { useState } from 'react'

vi.mock('plotly.js-dist-min', () => ({ default: {} }))
vi.mock('react-plotly.js/factory', () => ({ default: () => () => <div data-testid="plot" /> }))

const wide = (width: number) =>
  vi.stubGlobal('matchMedia', vi.fn((query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query)
    const matches = !/prefers-reduced-motion|prefers-color-scheme/.test(query) && (!min || width >= Number(min[1]))
    return { matches, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() }
  }))

const routes = () =>
  routeFetch({
    '/api/sessions': () => [detail()],
    '/api/kb/spectral': () => mockSpectral,
    '/api/sessions/s9': () => detail(),
    '/api/runs/r7/report': () => ({ ...mockReport, run_id: 'r7', title: 'Dairy line fat content' }),
  })

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
})
afterEach(() => vi.unstubAllGlobals())

describe('URL routing and history', () => {
  it('reads the view and the session from the path', () => {
    history.replaceState(null, '', '/a/s9')
    expect(readRoute()).toEqual({ view: 'thread', sessionId: 's9' })
    history.replaceState(null, '', '/history')
    expect(readRoute().view).toBe('history')
    history.replaceState(null, '', '/settings')
    expect(readRoute().view).toBe('settings')
    history.replaceState(null, '', '/nowhere')
    expect(readRoute()).toEqual({ view: 'home', sessionId: null })
  })

  it('opening an assessment pushes /a/<id>; Back returns to the history view and Forward reopens it', async () => {
    routes()
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Assessments' }))
    expect(location.pathname).toBe('/history')
    expect(screen.getByRole('button', { name: 'Assessments' })).toHaveAttribute('aria-current', 'page')
    fireEvent.click(await screen.findByRole('button', { name: /Dairy line fat content/ }))
    await screen.findByRole('tablist', { name: 'Report sections' })
    expect(location.pathname).toBe('/a/s9')

    act(() => { history.back() })
    await waitFor(() => expect(location.pathname).toBe('/history'))
    expect(await screen.findByRole('button', { name: /Dairy line fat content/ })).toBeInTheDocument()
    expect(screen.queryByRole('tablist', { name: 'Report sections' })).toBeNull()

    act(() => { history.forward() })
    expect(await screen.findByRole('tablist', { name: 'Report sections' })).toBeInTheDocument()
  })

  it('a reload on /a/<id> restores the open session', async () => {
    history.replaceState(null, '', '/a/s9')
    routes()
    renderApp()
    expect(await screen.findByRole('tablist', { name: 'Report sections' })).toBeInTheDocument()
  })

  it('Sources and Settings are routes with their own active state', () => {
    routes()
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(location.pathname).toBe('/settings')
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
    fireEvent.click(screen.getByRole('button', { name: 'Sources' }))
    expect(location.pathname).toBe('/sources')
    fireEvent.click(screen.getByRole('button', { name: 'New enquiry' }))
    expect(location.pathname).toBe('/')
  })

  it('the sidebar state persists', () => {
    routes()
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }))
    expect(localStorage.getItem('prism:sidebar')).toBe('expanded')
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toHaveAttribute('aria-expanded', 'true')
  })
})

describe('resizable split', () => {
  it('has a keyboard-accessible separator; the ratio persists and double click resets it', async () => {
    wide(1440)
    history.replaceState(null, '', '/a/s9')
    routes()
    renderApp()
    const sep = await screen.findByRole('separator', { name: /Resize conversation and report/ })
    expect(sep).toHaveAttribute('aria-valuenow', '42')
    fireEvent.keyDown(sep, { key: 'ArrowRight' })
    expect(sep).toHaveAttribute('aria-valuenow', '44')
    expect(localStorage.getItem('prism:split-ratio')).toBe('0.44')
    fireEvent.keyDown(sep, { key: 'ArrowLeft' })
    fireEvent.keyDown(sep, { key: 'ArrowLeft' })
    expect(sep).toHaveAttribute('aria-valuenow', '40')
    fireEvent.doubleClick(sep)
    expect(sep).toHaveAttribute('aria-valuenow', '42')
  })

  it('below 1024 px there is no divider, only the Conversation / Report switch', async () => {
    wide(768)
    history.replaceState(null, '', '/a/s9')
    routes()
    renderApp()
    expect(await screen.findByRole('button', { name: 'Report' })).toBeInTheDocument()
    expect(screen.queryByRole('separator', { name: /Resize/ })).toBeNull()
  })
})

describe('appearance', () => {
  it('Dark is applied at once and persisted; System follows the device', () => {
    routes()
    renderApp()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem('prism:appearance')).toBe('dark')
    fireEvent.click(screen.getByRole('radio', { name: 'Light' }))
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})

describe('copy in the chat', () => {
  it('copies the Markdown of an assistant message and confirms', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    render(<AssistantMessage text={'**NIR** fits.'} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy message' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('**NIR** fits.'))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })
})

describe('voice input', () => {
  class FakeRecorder {
    static instance: FakeRecorder | null = null
    static isTypeSupported = () => true
    state = 'inactive'
    mimeType = 'audio/webm;codecs=opus'
    ondataavailable: ((e: { data: Blob }) => void) | null = null
    onstop: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor() { FakeRecorder.instance = this }
    start() { this.state = 'recording' }
    stop() {
      this.state = 'inactive'
      this.ondataavailable?.({ data: new Blob(['voice'], { type: this.mimeType }) })
      void this.onstop?.()
    }
  }
  const track = { stop: vi.fn() }

  function Harness() {
    const [value, setValue] = useState('Fat in ')
    return <Composer value={value} onChange={setValue} onSubmit={() => {}} placeholder="Ask" deep={false} onDeepChange={() => {}} web={false} onWebChange={() => {}} offline={false} busy={false} docked />
  }
  const setup = (getUserMedia: () => Promise<unknown>) => {
    FakeRecorder.instance = null
    track.stop.mockClear()
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia } })
  }

  it('record, stop, upload and insert the transcript without sending', async () => {
    setup(async () => ({ getTracks: () => [track] }))
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: 'milk', language: 'en' })))
    vi.stubGlobal('fetch', fetchMock)
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Record voice' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/Recording · 0:00/)
    fireEvent.click(screen.getAllByRole('button', { name: 'Stop recording' })[0])
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Fat in milk'))
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: FormData }]
    expect(url).toBe('/api/speech/transcribe')
    expect(init.body.get('language')).toBe('auto')
    expect(init.body.get('audio')).toBeInstanceOf(Blob)
    expect(track.stop).toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('Escape cancels a recording and stops the microphone', async () => {
    setup(async () => ({ getTracks: () => [track] }))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Record voice' }))
    await screen.findByText(/Recording/)
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText(/Recording/)).toBeNull())
    expect(track.stop).toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows clear messages for a denied microphone and a failed transcription', async () => {
    setup(async () => { throw Object.assign(new Error('x'), { name: 'NotAllowedError' }) })
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Record voice' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/permission was denied/)

    setup(async () => ({ getTracks: () => [track] }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'No transcriber is configured for the active profile.' }), { status: 501 })))
    fireEvent.click(screen.getByRole('button', { name: 'Record voice' }))
    await screen.findByText(/Recording/)
    fireEvent.click(screen.getAllByRole('button', { name: 'Stop recording' })[0])
    expect(await screen.findByRole('alert')).toHaveTextContent('No transcriber is configured')
    expect(screen.getByRole('textbox')).toHaveValue('Fat in ')
  })

  it('reports an unsupported browser', async () => {
    vi.stubGlobal('MediaRecorder', undefined)
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Record voice' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/not supported/)
  })
})

describe('composer drafts', () => {
  it('a draft is kept per session in localStorage and restored on reload', async () => {
    routes()
    const first = renderApp()
    fireEvent.change(screen.getByRole('textbox', { name: /Paste a client enquiry/ }), { target: { value: 'Half-written enquiry' } })
    expect(localStorage.getItem('prism:draft:new')).toBe('Half-written enquiry')
    first.unmount()
    renderApp()
    expect(screen.getByRole('textbox', { name: /Paste a client enquiry/ })).toHaveValue('Half-written enquiry')
  })
})
