import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useFocusTrap } from '../../components/shell/useFocusTrap'
import { connectors, type MCPServer, type ServerInput, type Permission } from './api'
import './integrations.css'

const empty: ServerInput = { name: '', transport: 'http', url: '', stdio_id: '', auth_kind: 'none', header_name: 'Authorization', enabled: true, may_receive_assessment: false }
const message = (error: unknown) => error instanceof Error ? error.message : 'The request failed. Please try again.'

function ServerDialog({ server, onClose }: { server?: MCPServer; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<ServerInput>(server ? {
    name: server.name, transport: server.transport, url: server.url, stdio_id: server.stdio_id,
    auth_kind: server.auth_kind, header_name: server.header_name, enabled: server.enabled,
    may_receive_assessment: server.may_receive_assessment,
  } : { ...empty })
  const [busy, setBusy] = useState(false)
  const [tested, setTested] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(ref, true)
  const local = useQuery({ queryKey: ['mcp-stdio'], queryFn: connectors.stdio, retry: false })
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onClose])
  const change = (patch: Partial<ServerInput>) => { setDraft(d => ({ ...d, ...patch })); setTested(false); setNotice(''); setError('') }
  const payload = () => {
    const body = { ...draft }
    if (server && !body.secret) delete body.secret
    return body
  }
  const test = async () => {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await connectors.test(payload(), server?.id)
      setTested(result.ok)
      if (result.ok) setNotice(`Connected · ${result.tools?.length ?? 0} tools discovered`)
      else setError(result.error || 'The server could not be reached.')
    } catch (error) { setError(message(error)) } finally { setBusy(false) }
  }
  const save = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try { await connectors.save(payload(), server?.id); await queryClient.invalidateQueries({ queryKey: ['mcp'] }); onClose() }
    catch (error) { setError(message(error)) } finally { setBusy(false) }
  }
  return <div className="mcp-scrim" onMouseDown={e => e.target === e.currentTarget && !busy && onClose()}>
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="mcp-dialog-title" className="mcp-dialog">
      <h2 id="mcp-dialog-title">{server ? 'Edit server' : 'Add MCP server'}</h2>
      <form onSubmit={save} className="mcp-form">
        <label>Name<input required autoComplete="off" maxLength={120} value={draft.name} onChange={e => change({ name: e.target.value })} /></label>
        <label>Transport<select value={draft.transport} onChange={e => change({ transport: e.target.value as ServerInput['transport'], auth_kind: 'none', secret: '' })}>
          <option value="http">Streamable HTTP</option><option value="sse">SSE (legacy)</option><option value="stdio">Local stdio</option>
        </select></label>
        {draft.transport === 'stdio' ? <label>Allowlisted local server<select required value={draft.stdio_id} onChange={e => change({ stdio_id: e.target.value })}>
          <option value="">Choose a server</option>{local.data?.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>{!local.data?.length && <small>An administrator must add local servers to the allowlist.</small>}
          {local.isError && <small role="alert">The local server list could not be loaded.</small>}</label>
          : <><label>Server URL<input required type="url" autoComplete="off" placeholder="https://server.example/mcp" value={draft.url} onChange={e => change({ url: e.target.value })} /></label>
            <label>Authentication<select value={draft.auth_kind} onChange={e => change({ auth_kind: e.target.value as ServerInput['auth_kind'], secret: '' })}>
              <option value="none">None</option><option value="bearer">Bearer token</option><option value="header">Static header</option><option value="api_key">API key header</option><option value="oauth">OAuth 2.1</option>
            </select></label>
            {(draft.auth_kind === 'header' || draft.auth_kind === 'api_key') && <label>Header name<input required value={draft.header_name} onChange={e => change({ header_name: e.target.value })} /></label>}
            {['bearer', 'header', 'api_key'].includes(draft.auth_kind) && <label>Credential {server && `(${server.credentials})`}<input type="password" autoComplete="new-password" value={draft.secret ?? ''} onChange={e => change({ secret: e.target.value })} placeholder={server?.credentials === 'set' ? 'Leave blank to keep stored credential' : 'Enter credential'} />
              <small>Encrypted at rest. Stored credentials are never returned.</small></label>}
            {draft.auth_kind === 'oauth' && <p>Save this server, then choose Authorize to sign in. OAuth requires a saved server before testing.</p>}
          </>}
        <label className="mcp-check"><input type="checkbox" checked={draft.enabled} onChange={e => change({ enabled: e.target.checked })} />Enable server</label>
        <label className="mcp-check"><input type="checkbox" checked={draft.may_receive_assessment} onChange={e => change({ may_receive_assessment: e.target.checked })} />May receive assessment content</label>
        <small>Off by default. PRISM blocks arguments containing the enquiry text while this is off.</small>
        {notice && <p role="status">{notice}</p>}{error && <p role="alert" className="mcp-error">{error}</p>}
        <footer className="mcp-actions">
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" onClick={test} disabled={busy || draft.auth_kind === 'oauth' || !draft.name || (draft.transport === 'stdio' ? !draft.stdio_id : !draft.url)}>{busy ? 'Working…' : 'Test connection'}</button>
          <button type="submit" disabled={busy || (!tested && draft.auth_kind !== 'oauth')}>Save server</button>
        </footer>
      </form>
    </div>
  </div>
}

function ServerDetails({ server, perform }: { server: MCPServer; perform: (work: () => Promise<unknown>) => Promise<void> }) {
  const queryClient = useQueryClient()
  const [collection, setCollection] = useState('')
  const [imported, setImported] = useState('')
  const tools = useQuery({ queryKey: ['mcp', server.id, 'tools'], queryFn: () => connectors.tools(server.id), refetchInterval: 5000 })
  const resources = useQuery({ queryKey: ['mcp', server.id, 'resources'], queryFn: () => connectors.resources(server.id) })
  return <div className="mcp-details">
    <h3>Tools</h3>
    <button type="button" disabled={server.status !== 'connected'} onClick={() => perform(async () => {
      await connectors.tools(server.id, true); await queryClient.invalidateQueries({ queryKey: ['mcp', server.id] })
    })}>Refresh discovery</button>
    {tools.isPending && <p role="status">Loading tools…</p>}
    {tools.isError && <p role="alert">Tools could not be loaded.</p>}
    {tools.data?.length === 0 && <p>No tools discovered. Connect this server to discover its tools.</p>}
    {tools.data?.map(tool => <article className="mcp-tool" key={tool.name}>
      <div><strong>{tool.title || tool.name}</strong><p>{tool.description || 'No description supplied.'}</p>
        <small>{tool.annotations?.readOnlyHint === true ? 'Read-only' : 'May modify external data'}{tool.annotations?.destructiveHint === true && ' · Destructive · approval always required'}</small>
      </div>
      <label>Permission for {tool.name}<select value={tool.permission} onChange={e => perform(async () => {
        await connectors.permission(server.id, tool.name, e.target.value as Permission)
        await queryClient.invalidateQueries({ queryKey: ['mcp', server.id, 'tools'] })
      })}>
        <option value="disabled">Disabled</option><option value="allowed" disabled={tool.annotations?.destructiveHint === true}>Allowed</option><option value="ask">Ask every time</option>
      </select></label>
    </article>)}
    <h3>Resources</h3>
    {resources.isPending && <p role="status">Loading resources…</p>}
    {resources.isError && <p role="alert">Resources could not be loaded.</p>}
    {resources.data?.length === 0 && <p>No resources discovered.</p>}
    {!!resources.data?.length && <label>Import into collection<input placeholder="Collection id" value={collection} onChange={e => setCollection(e.target.value)} /></label>}
    {resources.data?.map(resource => <div className="mcp-resource" key={resource.uri}><div><strong>{resource.title || resource.name}</strong><small>{resource.uri}</small></div>
      <button type="button" disabled={!collection.trim() || server.status !== 'connected'} onClick={() => perform(async () => {
        await connectors.importResource(server.id, resource.uri, collection.trim(), resource.title || resource.name)
        setImported(`Imported ${resource.title || resource.name}`)
      })}>Import</button></div>)}
    {imported && <p role="status">{imported}</p>}
    <p className="mcp-muted">Live MCP results are unverified. Only an explicit import adds a resource to Sources.</p>
  </div>
}

export function IntegrationsPage() {
  const queryClient = useQueryClient()
  const [dialog, setDialog] = useState<MCPServer | 'new' | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [showAudit, setShowAudit] = useState(false)
  const servers = useQuery({ queryKey: ['mcp', 'servers'], queryFn: connectors.list, refetchInterval: 4000, retry: false })
  const audit = useQuery({ queryKey: ['mcp', 'audit'], queryFn: connectors.audit, enabled: showAudit, refetchInterval: showAudit ? 5000 : false })
  const perform = async (work: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try { await work(); await queryClient.invalidateQueries({ queryKey: ['mcp'] }) }
    catch (error) { setError(message(error)) } finally { setBusy(false) }
  }
  return <section aria-label="Integrations" className="feature-page mcp-page">
    <header className="mcp-heading"><div><p className="mcp-muted">Settings / Integrations</p><h1>MCP Servers</h1><p>Connect external tools and resources to PRISM.</p></div>
      <button type="button" onClick={() => setDialog('new')}>Add server</button></header>
    {error && <p role="alert" className="mcp-error">{error}</p>}
    {servers.isPending && <p role="status">Loading servers…</p>}
    {servers.isError && <p role="alert">Servers could not be loaded. <button onClick={() => servers.refetch()}>Retry</button></p>}
    {servers.data?.length === 0 && <div className="mcp-empty"><h2>No MCP servers yet</h2><p>Add a remote server or choose a local server approved by your administrator.</p></div>}
    {servers.data?.map(server => <article key={server.id} className="mcp-server" aria-label={server.name}>
      <header className="mcp-heading"><div><h2>{server.name}</h2><p className="mcp-status"><span className="mcp-dot" data-status={server.status} aria-hidden="true" />{server.status}{!server.enabled && ' · disabled'}</p><small>{server.transport} · {server.url || server.stdio_id}</small></div></header>
      {server.message && <p className="mcp-error">{server.message}</p>}
      {server.last_connected_at && <small>Last connected: {new Date(server.last_connected_at).toLocaleString()}</small>}
      <div className="mcp-actions">
        <button disabled={busy} onClick={() => perform(() => connectors.action(server.id, server.enabled ? 'disable' : 'enable'))}>{server.enabled ? 'Disable' : 'Enable'}</button>
        <button disabled={busy || server.status === 'connecting'} onClick={() => perform(() => connectors.action(server.id, server.status === 'connected' ? 'disconnect' : 'connect'))}>{server.status === 'connected' ? 'Disconnect' : 'Connect'}</button>
        {server.auth_kind === 'oauth' && <button disabled={busy} onClick={() => perform(async () => {
          const response = await connectors.oauth(server.id)
          // A new tab keeps this page (and its polling) alive while the scientist signs in.
          if (response.authorization_url) window.open(response.authorization_url, '_blank', 'noopener,noreferrer')
        })}>Authorize</button>}
        <button disabled={busy} onClick={() => setDialog(server)}>Edit</button>
        <button disabled={busy} onClick={() => { if (window.confirm(`Remove ${server.name}?`)) void perform(() => connectors.remove(server.id)) }}>Remove</button>
        <button aria-expanded={selected === server.id} onClick={() => setSelected(selected === server.id ? null : server.id)}>{selected === server.id ? 'Hide details' : 'Tools and resources'}</button>
      </div>
      {selected === server.id && <ServerDetails server={server} perform={perform} />}
    </article>)}
    <button aria-expanded={showAudit} onClick={() => setShowAudit(!showAudit)}>{showAudit ? 'Hide audit log' : 'View audit log'}</button>
    {showAudit && <section className="mcp-audit" aria-label="Connector audit log"><h2>Audit log</h2>
      <p>Argument values are redacted; only a hash and argument count are retained.</p>
      {audit.isPending && <p role="status">Loading audit log…</p>}{audit.isError && <p role="alert">Audit log could not be loaded.</p>}
      {audit.data?.length === 0 && <p>No tool calls yet.</p>}
      {audit.data?.map(entry => <article key={entry.id}><strong>{entry.tool} · {entry.outcome}</strong><p>{new Date(entry.time).toLocaleString()} · {entry.duration_ms} ms</p><p>{entry.summary}</p>{entry.error && <p className="mcp-error">{entry.error}</p>}</article>)}
    </section>}
    {dialog && <ServerDialog server={dialog === 'new' ? undefined : dialog} onClose={() => setDialog(null)} />}
  </section>
}
