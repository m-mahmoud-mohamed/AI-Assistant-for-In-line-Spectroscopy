// Settings → Integrations → MCP servers: fetch is stubbed; no network.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IntegrationsPage } from '../features/integrations/IntegrationsPage'
import type { MCPServer, MCPTool } from '../features/integrations/api'
import { routeFetch } from './helpers'

const server = (over: Partial<MCPServer> = {}): MCPServer => ({
  id: 'srv1', name: 'Lab server', transport: 'http', url: 'https://lab.example/mcp', stdio_id: '', auth_kind: 'bearer',
  header_name: 'Authorization', enabled: true, may_receive_assessment: false, credentials: 'set', status: 'connected',
  message: null, last_connected_at: '2026-10-18T09:00:00Z', ...over,
})
const tools: MCPTool[] = [
  { name: 'search', description: 'Search notes', inputSchema: {}, permission: 'allowed', annotations: { readOnlyHint: true } },
  { name: 'create_issue', description: 'Create an issue', inputSchema: {}, permission: 'ask', annotations: { destructiveHint: true } },
]
const val = <T,>(value: T) => () => value
const page = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><IntegrationsPage /></QueryClientProvider>)
afterEach(() => vi.unstubAllGlobals())

describe('IntegrationsPage', () => {
  it('shows an empty state with the add action', async () => {
    routeFetch({ '/api/connectors': val([]) })
    page()
    expect(await screen.findByText('No MCP servers yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add server' })).toBeInTheDocument()
  })

  it('lists servers with status and errors, never showing stored credentials', async () => {
    routeFetch({ '/api/connectors': val([server(), server({ id: 'srv2', name: 'Broken', status: 'error', message: 'MCP connection or request failed; check the server and authentication', credentials: 'not set' })]) })
    page()
    const ok = await screen.findByRole('article', { name: 'Lab server' })
    expect(within(ok).getByText('connected')).toBeInTheDocument()
    expect(screen.getByText(/MCP connection or request failed/)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/secret|token value/i)
  })

  it('shows read-only and destructive hints and saves a permission change', async () => {
    const { calls } = routeFetch({
      '/api/connectors': val([server()]),
      '/api/connectors/srv1/tools?refresh=false': val(tools),
      '/api/connectors/srv1/resources': val([]),
      'PATCH /api/connectors/srv1/tools': () => tools,
    })
    page()
    fireEvent.click(await screen.findByRole('button', { name: 'Tools and resources' }))
    expect(await screen.findByText(/Destructive · approval always required/)).toBeInTheDocument()
    expect(screen.getByText('Read-only')).toBeInTheDocument()
    const select = screen.getByLabelText('Permission for search')
    fireEvent.change(select, { target: { value: 'ask' } })
    await waitFor(() => expect(calls).toContain('PATCH /api/connectors/srv1/tools'))
    expect(within(screen.getByLabelText('Permission for create_issue')).getByRole('option', { name: 'Allowed' })).toBeDisabled()
  })

  it('tests a new server before it can be saved, with a write-only credential', async () => {
    let saved: Record<string, unknown> | undefined
    routeFetch({
      '/api/connectors': val([]), '/api/connectors/stdio': val([{ id: 'lab', name: 'Laboratory MCP' }]),
      'POST /api/connectors/test': () => ({ ok: true, tools }),
      'POST /api/connectors': (init) => { saved = JSON.parse(String(init?.body)); return server() },
    })
    page()
    fireEvent.click(await screen.findByRole('button', { name: 'Add server' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add MCP server' })
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Lab server' } })
    fireEvent.change(within(dialog).getByLabelText('Server URL'), { target: { value: 'https://lab.example/mcp' } })
    fireEvent.change(within(dialog).getByLabelText('Authentication'), { target: { value: 'bearer' } })
    const credential = within(dialog).getByLabelText(/Credential/)
    expect(credential).toHaveAttribute('type', 'password')
    fireEvent.change(credential, { target: { value: 'write-only-value' } })
    expect(within(dialog).getByRole('button', { name: 'Save server' })).toBeDisabled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Test connection' }))
    expect(await within(dialog).findByText(/Connected · 2 tools discovered/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save server' }))
    await waitFor(() => expect(saved).toMatchObject({ name: 'Lab server', auth_kind: 'bearer', secret: 'write-only-value' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('offers only allowlisted stdio servers and never a command field', async () => {
    routeFetch({ '/api/connectors': val([]), '/api/connectors/stdio': val([{ id: 'lab', name: 'Laboratory MCP' }]) })
    page()
    fireEvent.click(await screen.findByRole('button', { name: 'Add server' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Transport'), { target: { value: 'stdio' } })
    expect(await within(dialog).findByRole('option', { name: 'Laboratory MCP' })).toBeInTheDocument()
    expect(within(dialog).queryByLabelText(/command/i)).not.toBeInTheDocument()
    expect(within(dialog).queryByLabelText('Server URL')).not.toBeInTheDocument()
  })

  it('shows a failed test as an alert and keeps Save disabled', async () => {
    routeFetch({ '/api/connectors': val([]), '/api/connectors/stdio': val([]), 'POST /api/connectors/test': () => ({ ok: false, error: 'MCP request timed out' }) })
    page()
    fireEvent.click(await screen.findByRole('button', { name: 'Add server' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Slow' } })
    fireEvent.change(within(dialog).getByLabelText('Server URL'), { target: { value: 'https://slow.example/mcp' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Test connection' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('MCP request timed out')
    expect(within(dialog).getByRole('button', { name: 'Save server' })).toBeDisabled()
  })

  it('imports a resource only after a collection is chosen, and shows the audit log', async () => {
    let imported: Record<string, unknown> | undefined
    routeFetch({
      '/api/connectors': val([server()]), '/api/connectors/srv1/tools?refresh=false': val([]),
      '/api/connectors/srv1/resources': val([{ name: 'notes', uri: 'lab://notes', title: 'Lab notes' }]),
      'POST /api/connectors/srv1/resources/import': (init) => { imported = JSON.parse(String(init?.body)); return { id: 'doc1' } },
      '/api/connectors/audit': val([{ id: 1, time: '2026-10-18T09:00:00Z', session: 's', server: 'srv1', tool: 'search', summary: '1 arguments · values redacted', outcome: 'ok', duration_ms: 12, error: null }]),
    })
    page()
    fireEvent.click(await screen.findByRole('button', { name: 'Tools and resources' }))
    const button = await screen.findByRole('button', { name: 'Import' })
    expect(button).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Import into collection'), { target: { value: 'lab' } })
    fireEvent.click(button)
    await waitFor(() => expect(imported).toEqual({ uri: 'lab://notes', collection: 'lab', title: 'Lab notes' }))
    fireEvent.click(screen.getByRole('button', { name: 'View audit log' }))
    expect(await screen.findByText(/search · ok/)).toBeInTheDocument()
    expect(screen.getByText(/values redacted/)).toBeInTheDocument()
  })

  it('reports a load failure with a retry', async () => {
    routeFetch({})
    page()
    expect(await screen.findByRole('alert')).toHaveTextContent('Servers could not be loaded')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})
