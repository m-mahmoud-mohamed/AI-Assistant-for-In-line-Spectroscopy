import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FolderOpen, Upload, Link, X } from 'lucide-react'
import { useFocusTrap } from '../../components/shell/useFocusTrap'
import { SOURCE_KIND_LABEL } from '../../components/panel/tiers'
import { sourcesApi, type Job, type Source, type UploadEntry } from './api'
import { droppedFiles } from './drop'
import './sources.css'

const terminal = (job: Job) => job.status === 'ready' || job.status === 'failed'
const message = (error: unknown) => error instanceof Error ? error.message : 'The request failed. Please retry.'
type Confirm = { title: string; text: string; run: () => Promise<void> }

function Dialog({ title, children, close, drawer = false }: { title: string; children: ReactNode; close: () => void; drawer?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(ref, true)
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [close])
  return <div className="sources-overlay" onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
    <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className={drawer ? 'sources-drawer' : 'sources-dialog'}>
      <header><h2>{title}</h2><button className="btn" type="button" aria-label="Close" onClick={close}><X size={16} aria-hidden="true" /></button></header>
      {children}
    </div>
  </div>
}

function SourceDrawer({ source, close }: { source: Source; close: () => void }) {
  const detail = useQuery({ queryKey: ['source-detail', source.id], queryFn: () => sourcesApi.detail(source.id), retry: false })
  const data = detail.data
  return <Dialog title={source.title} close={close} drawer>
    {detail.isPending && <p role="status">Loading document…</p>}
    {detail.isError && <p role="alert">{message(detail.error)}</p>}
    {data && <>
      <dl className="sources-metadata">
        {Object.entries({ Kind: SOURCE_KIND_LABEL[data.kind], Status: data.status, Collection: data.collection,
          Pages: data.pages, Chunks: data.chunks, Size: `${data.size.toLocaleString()} bytes`, Added: data.added_at,
          Filename: data.relative_path, 'Content hash (SHA-256)': data.sha256,
          ...data.origin }).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{String(value)}</dd></div>)}
      </dl>
      {data.error && <p role="alert" className="inline-error">{data.error}</p>}
      <h3>Extracted text</h3>
      {data.preview.length === 0 && <p>No text has been extracted yet.</p>}
      {data.preview.map(page => <section key={page.page}><h4>Page {page.page}</h4><pre>{page.text}</pre>{page.truncated && <p>Preview limited to 5,000 characters.</p>}</section>)}
      {data.preview_truncated && <p>Showing the first 100 pages.</p>}
    </>}
  </Dialog>
}

export function SourcesPage() {
  const cache = useQueryClient()
  const [collection, setCollection] = useState('')
  const [offset, setOffset] = useState(0)
  const [jobs, setJobs] = useState<Job[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Source | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [linksOpen, setLinksOpen] = useState(false)
  const [links, setLinks] = useState('')
  const [collectionForm, setCollectionForm] = useState<{ id?: string; name: string } | null>(null)
  const files = useRef<HTMLInputElement>(null)
  const folder = useRef<HTMLInputElement>(null)
  const collections = useQuery({ queryKey: ['source-collections'], queryFn: sourcesApi.collections, retry: false })
  const sources = useQuery({ queryKey: ['sources', collection, offset], queryFn: () => sourcesApi.list(collection, offset), retry: false })
  const target = collection || 'default'
  const chosen = collections.data?.find(c => c.id === collection)
  const invalidate = async () => {
    await Promise.all([cache.invalidateQueries({ queryKey: ['sources'] }), cache.invalidateQueries({ queryKey: ['source-collections'] }), cache.invalidateQueries({ queryKey: ['source-detail'] })])
  }
  async function action(run: () => Promise<void>) {
    setError(''); setBusy(true)
    try { await run(); await invalidate() } catch (error) { setError(message(error)) } finally { setBusy(false) }
  }
  useEffect(() => { folder.current?.setAttribute('webkitdirectory', '') }, [])
  useEffect(() => {
    const pending = jobs.filter(job => !terminal(job))
    if (!pending.length) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      Promise.all(pending.map(job => sourcesApi.job(job.id))).then(updates => {
        if (cancelled) return
        const byId = new Map(updates.map(job => [job.id, job]))
        setJobs(previous => previous.map(job => byId.get(job.id) ?? job))
        if (updates.some(terminal)) {
          void cache.invalidateQueries({ queryKey: ['sources'] })
          void cache.invalidateQueries({ queryKey: ['source-collections'] })
        }
      }).catch(error => { if (!cancelled) { setError(`Could not refresh import progress: ${message(error)}`); setJobs(previous => [...previous]) } })
    }, 800)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [jobs, cache])
  async function upload(entries: UploadEntry[]) {
    if (!entries.length) return
    await action(async () => {
      if (entries.length > 100) throw new Error('Choose no more than 100 files per batch.')
      if (entries.some(e => e.file.size > 50 * 1024 * 1024)) throw new Error('Each file must be no larger than 50 MB.')
      if (entries.reduce((sum, e) => sum + e.file.size, 0) > 200 * 1024 * 1024) throw new Error('A batch must be no larger than 200 MB.')
      const result = await sourcesApi.upload(target, entries)
      setJobs(previous => [...result.jobs, ...previous])
    })
  }
  function pick(input: HTMLInputElement) {
    const entries = Array.from(input.files ?? []).map(file => ({ file, path: file.webkitRelativePath || file.name }))
    input.value = ''; void upload(entries)
  }
  function reindex(source?: Source) {
    setConfirm({ title: source ? `Re-index ${source.title}?` : 'Re-index all sources?', text: 'Re-extract and rebuild evidence from the stored documents. New assessments use the updated index.', run: async () => {
      const result = await sourcesApi.reindex(source?.id)
      setJobs(previous => [...('jobs' in result ? result.jobs : [result]), ...previous])
    } })
  }
  return <section aria-label="Sources" className="sources-page feature-page">
    <header className="sources-heading"><div><h1>Sources</h1><p>Build your evidence library. Imported sources are cited separately from the AFS knowledge base.</p></div><button className="btn" onClick={() => reindex()} disabled={busy || !sources.data?.total}>Re-index all</button></header>
    <div className="sources-layout">
      <aside aria-label="Collections" className="sources-collections">
        <h2>Collections</h2>
        <button className="btn" aria-pressed={!collection} onClick={() => { setCollection(''); setOffset(0) }}>All sources</button>
        {collections.isPending && <p role="status">Loading collections…</p>}
        {collections.isError && <p role="alert">{message(collections.error)}</p>}
        {collections.data?.map(item => <button key={item.id} className="btn" aria-pressed={collection === item.id} onClick={() => { setCollection(item.id); setOffset(0) }}>{item.name} <span>{item.sources}</span></button>)}
        <button className="btn" onClick={() => setCollectionForm({ name: '' })}>New collection</button>
        {chosen && <>
          <button className="link-btn" onClick={() => setCollectionForm({ id: chosen.id, name: chosen.name })}>Rename collection</button>
          {chosen.id !== 'default' && <button className="link-btn" onClick={() => setConfirm({ title: `Delete ${chosen.name}?`, text: 'Its sources will move to General.', run: async () => { await sourcesApi.deleteCollection(chosen.id); setCollection(''); setOffset(0) } })}>Delete collection</button>}
        </>}
      </aside>
      <main className="sources-main">
        <div className="sources-drop" onDragOver={event => event.preventDefault()} onDrop={event => {
          event.preventDefault()
          if (!busy) void droppedFiles(event.dataTransfer).then(upload).catch(error => setError(message(error)))
        }}>
          <Upload size={24} aria-hidden="true" /><h2>Drop documents or folders here</h2>
          <p>PDF, DOCX, TXT, MD and HTML · up to 50 MB each · 100 files / 200 MB per batch</p>
          <p>Import into {collections.data?.find(c => c.id === target)?.name ?? 'General'}</p>
          <div className="sources-actions">
            <button className="btn btn-primary" disabled={busy} onClick={() => files.current?.click()}><Upload size={16} aria-hidden="true" /> Upload files</button>
            <button className="btn" disabled={busy} onClick={() => folder.current?.click()}><FolderOpen size={16} aria-hidden="true" /> Upload folder</button>
            <button className="btn" disabled={busy} onClick={() => setLinksOpen(true)}><Link size={16} aria-hidden="true" /> Add links</button>
          </div>
          <input hidden ref={files} type="file" multiple aria-label="Upload documents" accept=".pdf,.docx,.txt,.md,.html,.htm" onChange={event => pick(event.currentTarget)} />
          <input hidden ref={folder} type="file" multiple aria-label="Upload directory" onChange={event => pick(event.currentTarget)} />
        </div>
        {busy && <p role="status">Working…</p>}
        {error && <p role="alert" className="inline-error">{error}</p>}
        {jobs.length > 0 && <section aria-label="Import progress" className="sources-jobs"><header><h2>Imports</h2><button className="link-btn" onClick={() => setJobs(previous => previous.filter(job => !terminal(job)))}>Clear completed</button></header>
          <ul>{jobs.map(job => <li key={job.id}><strong>{job.title}</strong><span>{job.duplicate ? 'Already exists' : job.status}</span>
            {!terminal(job) && <progress value={job.progress} max={100} aria-label={`${job.title} progress`} />}
            {job.error && <p role="alert" className="inline-error">{job.error}</p>}
          </li>)}</ul>
        </section>}
        <section aria-label="Imported sources"><h2>{chosen?.name ?? 'All sources'} <span className="sources-count">{sources.data?.total ?? ''}</span></h2>
          {sources.isPending && <p role="status">Loading sources…</p>}
          {sources.isError && <p role="alert">{message(sources.error)} <button className="link-btn" onClick={() => void sources.refetch()}>Retry</button></p>}
          {sources.data?.items.length === 0 && <p>No sources yet. Upload documents or add a website link to get started.</p>}
          {!!sources.data?.items.length && <div className="sources-table-wrap"><table><caption className="sources-visually-hidden">Imported source library</caption><thead><tr><th>Source</th><th>Kind</th><th>Details</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>{sources.data.items.map(source => <tr key={source.id}>
              <td><button className="link-btn" onClick={() => setSelected(source)}>{source.title}</button><small>{source.origin.url || source.relative_path}</small><small>{collections.data?.find(c => c.id === source.collection)?.name}</small></td>
              <td><span className="pill pill-info">{SOURCE_KIND_LABEL[source.kind]}</span></td>
              <td>{source.pages} pages · {source.chunks} chunks<small>{Math.ceil(source.size / 1024)} KB · {new Date(source.added_at).toLocaleDateString()}</small></td>
              <td>{source.status}{source.error && <small className="inline-error">{source.error}</small>}</td>
              <td><div className="sources-actions"><button className="btn" disabled={busy} aria-label={`Re-index ${source.title}`} onClick={() => reindex(source)}>Re-index</button><button className="btn" disabled={busy} aria-label={`Delete ${source.title}`} onClick={() => setConfirm({ title: `Delete ${source.title}?`, text: 'Remove the stored document, chunks and index entries. Existing reports retain their quoted evidence.', run: async () => { await sourcesApi.remove(source.id); if (selected?.id === source.id) setSelected(null) } })}>Delete</button></div></td>
            </tr>)}</tbody></table></div>}
          {sources.data && sources.data.total > 25 && <nav className="sources-actions" aria-label="Source pages"><button className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>Previous</button><span>{offset + 1}–{Math.min(offset + 25, sources.data.total)} of {sources.data.total}</span><button className="btn" disabled={offset + 25 >= sources.data.total} onClick={() => setOffset(offset + 25)}>Next</button></nav>}
        </section>
      </main>
    </div>
    {selected && <SourceDrawer source={selected} close={() => setSelected(null)} />}
    {linksOpen && <Dialog title="Add website links" close={() => setLinksOpen(false)}><form onSubmit={event => { event.preventDefault(); void action(async () => {
      const urls = links.split(/\s+/).filter(Boolean)
      if (!urls.length || urls.length > 100) throw new Error('Enter 1–100 HTTP/HTTPS links.')
      const result = await sourcesApi.urls(target, urls); setJobs(previous => [...result.jobs, ...previous]); setLinksOpen(false); setLinks('')
    }) }}><label htmlFor="source-links">One URL per line</label><textarea id="source-links" required value={links} onChange={event => setLinks(event.target.value)} rows={6} /><button className="btn btn-primary" disabled={busy}>Import links</button>{error && <p role="alert">{error}</p>}</form></Dialog>}
    {collectionForm && <Dialog title={collectionForm.id ? 'Rename collection' : 'New collection'} close={() => setCollectionForm(null)}><form onSubmit={event => { event.preventDefault(); void action(async () => {
      if (collectionForm.id) await sourcesApi.renameCollection(collectionForm.id, collectionForm.name)
      else { const created = await sourcesApi.createCollection(collectionForm.name); setCollection(created.id); setOffset(0) }
      setCollectionForm(null)
    }) }}><label htmlFor="collection-name">Collection name</label><input id="collection-name" required maxLength={120} value={collectionForm.name} onChange={event => setCollectionForm({ ...collectionForm, name: event.target.value })} /><button className="btn btn-primary" disabled={busy}>Save collection</button>{error && <p role="alert">{error}</p>}</form></Dialog>}
    {confirm && <Dialog title={confirm.title} close={() => { if (!busy) setConfirm(null) }}><p>{confirm.text}</p><div className="sources-actions"><button className="btn" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={() => void action(async () => { await confirm.run(); setConfirm(null) })}>Confirm</button></div>{error && <p role="alert">{error}</p>}</Dialog>}
  </section>
}
