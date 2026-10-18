import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SourcesPage } from '../features/sources/SourcesPage'
import type { Job, Source } from '../features/sources/api'
import { droppedFiles, prepareUpload } from '../features/sources/drop'

const source = (over: Partial<Source> = {}): Source => ({
  id: 'a'.repeat(32), collection: 'default', title: 'Zeolite guide', kind: 'UPLOAD', filename: 'guide.pdf',
  relative_path: 'lab/guide.pdf', mime: 'application/pdf', size: 2048, sha256: 'f'.repeat(64), pages: 3, chunks: 7,
  added_at: '2026-10-18T10:00:00+00:00', status: 'ready', error: '', canonical_url: null, origin: { kind: 'upload' }, ...over,
})
const job = (over: Partial<Job> = {}): Job => ({ id: 'j1', source_id: null, title: 'guide.pdf', status: 'queued', progress: 0, error: '', duplicate: false, ...over })

interface Server { sources: Source[]; calls: { method: string; url: string; body?: BodyInit | null }[]; jobs: Record<string, Job[]>; handlers: Record<string, () => Response | Job | object> }
let server: Server

function respond(body: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  server = { sources: [], calls: [], jobs: {}, handlers: {} }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    server.calls.push({ method, url, body: init?.body })
    if (url === '/api/sources/collections' && method === 'GET') return respond([{ id: 'default', name: 'General', sources: server.sources.length }])
    if (url.startsWith('/api/sources/sources?')) return respond({ items: server.sources, total: server.sources.length })
    if (url.startsWith('/api/sources/jobs/')) {
      const queue = server.jobs[url.split('/').pop()!] ?? []
      return respond(queue.length > 1 ? queue.shift() : queue[0])
    }
    if (url === '/api/sources/upload') return respond(server.handlers.upload(), 202)
    if (url === '/api/sources/urls') return respond(server.handlers.urls(), 202)
    if (url.endsWith('/reindex')) return respond(server.handlers.reindex(), 202)
    if (url.match(/\/api\/sources\/sources\/\w+$/) && method === 'DELETE') { server.sources = []; return respond(null, 204) }
    if (url.match(/\/api\/sources\/sources\/\w+$/)) return respond({ ...server.sources[0], preview: [{ page: 1, text: 'Extracted page text', truncated: false }], preview_truncated: false })
    return respond({ detail: 'unexpected' }, 404)
  }))
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><SourcesPage /></QueryClientProvider>)
}

describe('SourcesPage', () => {
  it('shows a loading state, then the empty state with the upload actions', async () => {
    renderPage()
    expect(screen.getByText('Loading sources…')).toBeInTheDocument()
    expect(await screen.findByText(/No sources yet/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Upload files/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Upload folder/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Add links/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Re-index all' })).toBeDisabled()
  })

  it('lists sources with kind badges and metadata, and opens the metadata drawer with the text preview', async () => {
    server.sources = [source(), source({ id: 'b'.repeat(32), title: 'Probe vendor page', kind: 'WEB', origin: { kind: 'web', url: 'https://example.org/probe' } })]
    renderPage()
    const table = await screen.findByRole('table')
    expect(within(table).getByText('Uploaded document')).toBeInTheDocument()
    expect(within(table).getByText('Website')).toBeInTheDocument()
    expect(within(table).getByText('https://example.org/probe')).toBeInTheDocument()
    expect(within(table).getAllByText('3 pages · 7 chunks', { exact: false }).length).toBe(2)
    fireEvent.click(within(table).getByRole('button', { name: 'Zeolite guide' }))
    const drawer = await screen.findByRole('dialog', { name: 'Zeolite guide' })
    expect(await within(drawer).findByText('Extracted page text')).toBeInTheDocument()
    expect(within(drawer).getByText('f'.repeat(64))).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('uploads files preserving relative paths and shows per-file progress, duplicates and errors', async () => {
    server.handlers.upload = () => ({ jobs: [job({ id: 'j1' }), job({ id: 'j2', title: 'scan.pdf', status: 'failed', error: 'No extractable text; scanned/empty documents need OCR before import' }),
      job({ id: 'j3', title: 'again.txt', status: 'ready', progress: 100, duplicate: true })] })
    server.jobs.j1 = [job({ id: 'j1', status: 'indexing', progress: 75 }), job({ id: 'j1', status: 'ready', progress: 100 })]
    renderPage()
    await screen.findByText(/No sources yet/)
    const input = screen.getByLabelText('Upload documents') as HTMLInputElement
    const file = new File(['%PDF-1.7'], 'guide.pdf', { type: 'application/pdf' })
    fireEvent.change(input, { target: { files: [file] } })
    const progress = await screen.findByRole('region', { name: 'Import progress' })
    expect(within(progress).getByText('guide.pdf')).toBeInTheDocument()
    expect(within(progress).getByRole('progressbar', { name: 'guide.pdf progress' })).toBeInTheDocument()
    expect(within(progress).getByText(/need OCR/)).toBeInTheDocument()
    expect(within(progress).getByText('Already exists')).toBeInTheDocument()
    const upload = server.calls.find(c => c.url === '/api/sources/upload')!
    const form = upload.body as FormData
    expect(form.get('collection')).toBe('default')
    expect(form.get('relative_paths')).toBe('["guide.pdf"]')
    expect((form.getAll('files')[0] as File).name).toBe('guide.pdf')
    await waitFor(() => expect(within(progress).queryByRole('progressbar')).not.toBeInTheDocument(), { timeout: 4000 })
    expect(within(progress).getAllByText('ready').length).toBeGreaterThan(0)
  })

  it('rejects oversized batches in the browser before sending', async () => {
    renderPage()
    await screen.findByText(/No sources yet/)
    const big = new File(['x'], 'big.pdf')
    Object.defineProperty(big, 'size', { value: 51 * 1024 * 1024 })
    fireEvent.change(screen.getByLabelText('Upload documents'), { target: { files: [big] } })
    expect(await screen.findByText(/no larger than 50 MB/)).toBeInTheDocument()
    expect(server.calls.some(c => c.url === '/api/sources/upload')).toBe(false)
  })

  it('submits pasted links and surfaces a rejected request', async () => {
    server.handlers.urls = () => ({ jobs: [job({ id: 'u1', title: 'https://example.org/a', status: 'failed', error: 'Private, loopback and local hosts are not allowed' })] })
    renderPage()
    await screen.findByText(/No sources yet/)
    fireEvent.click(screen.getByRole('button', { name: /Add links/ }))
    const dialog = screen.getByRole('dialog', { name: 'Add website links' })
    fireEvent.change(within(dialog).getByLabelText('One URL per line'), { target: { value: 'https://example.org/a\nhttp://localhost/b' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import links' }))
    expect(await screen.findByText(/loopback and local hosts/)).toBeInTheDocument()
    const body = JSON.parse(server.calls.find(c => c.url === '/api/sources/urls')!.body as string)
    expect(body).toEqual({ collection: 'default', urls: ['https://example.org/a', 'http://localhost/b'] })
  })

  it('asks for confirmation before deleting and removes the source', async () => {
    server.sources = [source()]
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Zeolite guide' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete Zeolite guide?' })
    expect(server.calls.some(c => c.method === 'DELETE')).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(server.calls.some(c => c.method === 'DELETE')).toBe(true))
    expect(await screen.findByText(/No sources yet/)).toBeInTheDocument()
  })

  it('shows a failed source with its error', async () => {
    server.sources = [source({ status: 'failed', error: 'No extractable text' })]
    renderPage()
    expect(await screen.findByText('No extractable text')).toBeInTheDocument()
  })
})


describe('upload recovery and folder selection', () => {
  it('skips unsupported, hidden and empty files while uploading supported files without MIME types', async () => {
    server.handlers.upload = () => ({ jobs: [job({ status: 'ready' })] })
    renderPage()
    await screen.findByText(/No sources yet/)
    const files = [new File(['NIR notes'], 'notes.md'), new File(['<html><p>Raman</p></html>'], 'page.html'),
      new File(['x'], '.DS_Store'), new File(['x'], 'Thumbs.db'), new File(['x'], 'data.csv'), new File([], 'empty.txt')]
    files.forEach(file => Object.defineProperty(file, 'webkitRelativePath', { value: `lab/nested/${file.name}` }))
    fireEvent.change(screen.getByLabelText('Upload directory'), { target: { files } })
    const skipped = await screen.findByRole('region', { name: 'Skipped files' })
    expect(within(skipped).getAllByRole('listitem')).toHaveLength(4)
    expect(skipped).toHaveTextContent('lab/nested/data.csv: Unsupported file type')
    expect(skipped).toHaveTextContent('lab/nested/empty.txt: File is empty')
    await waitFor(() => expect(server.calls.some(c => c.url === '/api/sources/upload')).toBe(true))
    const form = server.calls.find(c => c.url === '/api/sources/upload')!.body as FormData
    expect(form.get('relative_paths')).toBe('["lab/nested/notes.md","lab/nested/page.html"]')
    expect(form.getAll('files')).toHaveLength(2)
  })

  it('refreshes the library when polling finishes and shows embedding notes without an error alert', async () => {
    const note = 'Semantic index pending: the embedding service was unavailable'
    server.handlers.upload = () => ({ jobs: [job()] })
    server.jobs.j1 = [job({ status: 'ready', error: note, progress: 100 })]
    renderPage()
    await screen.findByText(/No sources yet/)
    fireEvent.change(screen.getByLabelText('Upload documents'), { target: { files: [new File(['notes'], 'notes.txt')] } })
    await screen.findByRole('region', { name: 'Import progress' })
    server.sources = [source({ error: note })]
    const table = await screen.findByRole('table', {}, { timeout: 4000 })
    expect(table).toHaveTextContent(note)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('region', { name: 'Import progress' })).toHaveTextContent(note)
  })

  it('retries a failed persisted job from Imports and refreshes its source on completion', async () => {
    server.handlers.upload = () => ({ jobs: [job({ source_id: source().id, status: 'failed', error: 'Import interrupted; re-index to retry' })] })
    server.handlers.reindex = () => {
      server.sources = [source({ status: 'indexing' })]
      return job({ id: 'retry', source_id: source().id })
    }
    server.jobs.retry = [job({ id: 'retry', source_id: source().id, status: 'ready', progress: 100 })]
    renderPage()
    await screen.findByText(/No sources yet/)
    fireEvent.change(screen.getByLabelText('Upload documents'), { target: { files: [new File(['notes'], 'notes.txt')] } })
    fireEvent.click(await screen.findByRole('button', { name: 'Retry guide.pdf' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(server.calls.some(c => c.method === 'POST' && c.url.endsWith('/reindex'))).toBe(true))
    server.sources = [source()]
    await waitFor(() => expect(screen.getByRole('table')).toHaveTextContent('ready'), { timeout: 4000 })
  })

  it('does not count unsupported files against the supported batch limit', () => {
    const entries = Array.from({ length: 110 }, (_, i) => ({ file: new File(['x'], `${i}.csv`), path: `lab/${i}.csv` }))
    entries.push({ file: new File(['notes'], 'notes.txt'), path: 'lab/notes.txt' })
    expect(prepareUpload(entries).supported).toHaveLength(1)
    expect(prepareUpload(entries).skipped).toHaveLength(110)
  })

  it('walks every directory batch and preserves nested drop paths', async () => {
    const file = (name: string) => ({ name, isFile: true, file: (resolve: (file: File) => void) => resolve(new File(['notes'], name)) })
    const dir = (name: string, batches: unknown[][]) => ({ name, isDirectory: true, createReader: () => ({ readEntries: (resolve: (entries: unknown[]) => void) => resolve(batches.shift() ?? []) }) })
    const root = dir('lab', [[file('one.md')], [dir('nested', [[file('two.txt')], []])], []])
    const entries = await droppedFiles({ items: [{ webkitGetAsEntry: () => root }], files: [] } as unknown as DataTransfer)
    expect(entries.map(entry => entry.path)).toEqual(['lab/one.md', 'lab/nested/two.txt'])
  })
})
