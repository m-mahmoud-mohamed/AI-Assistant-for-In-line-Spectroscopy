import { ApiError } from '../../api'

export type Permission = 'disabled' | 'allowed' | 'ask'
export interface MCPServer {
  id: string
  name: string
  transport: 'http' | 'sse' | 'stdio'
  url: string
  stdio_id: string
  auth_kind: 'none' | 'bearer' | 'header' | 'api_key' | 'oauth'
  header_name: string
  enabled: boolean
  may_receive_assessment: boolean
  credentials: 'set' | 'not set'
  status: 'connected' | 'connecting' | 'disconnected' | 'error'
  message: string | null
  last_connected_at: string | null
}
export type ServerInput = Pick<MCPServer, 'name' | 'transport' | 'url' | 'stdio_id' | 'auth_kind' | 'header_name' | 'enabled' | 'may_receive_assessment'> & { secret?: string }
export interface MCPTool {
  name: string
  title?: string
  description?: string
  inputSchema: Record<string, unknown>
  permission: Permission
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
}
export interface MCPResource { name: string; title?: string; uri: string; mimeType?: string }
export interface AuditEntry { id: number; time: string; session: string; server: string; tool: string; summary: string; outcome: string; duration_ms: number; error: string | null }

async function request<T>(path = '', method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`/api/connectors${path}`, { method,
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!res.ok) {
    let message = 'The connector request failed. Please try again.'
    try { const data = await res.json(); if (typeof data.detail === 'string') message = data.detail } catch { /* keep safe fallback */ }
    throw new ApiError(res.status, path, message)
  }
  return res.json() as Promise<T>
}
const pathFor = (id: string) => `/${encodeURIComponent(id)}`
export const connectors = {
  list: () => request<MCPServer[]>(),
  stdio: () => request<{ id: string; name: string }[]>('/stdio'),
  save: (body: ServerInput, id?: string) => request<MCPServer>(id ? pathFor(id) : '', id ? 'PATCH' : 'POST', body),
  patch: (id: string, body: Partial<ServerInput>) => request<MCPServer>(pathFor(id), 'PATCH', body),
  test: (body: ServerInput, id?: string) => request<{ ok: boolean; tools?: MCPTool[]; error?: string }>(id ? `${pathFor(id)}/test` : '/test', 'POST', body),
  remove: (id: string) => request(`${pathFor(id)}`, 'DELETE'),
  action: (id: string, action: 'connect' | 'disconnect' | 'enable' | 'disable') => request<MCPServer>(`${pathFor(id)}/${action}`, 'POST'),
  tools: (id: string, refresh = false) => request<MCPTool[]>(`${pathFor(id)}/tools?refresh=${refresh}`),
  permission: (id: string, name: string, permission: Permission) => request<MCPTool[]>(`${pathFor(id)}/tools`, 'PATCH', { permissions: { [name]: permission } }),
  resources: (id: string) => request<MCPResource[]>(`${pathFor(id)}/resources`),
  importResource: (id: string, uri: string, collection: string, title: string) => request(`${pathFor(id)}/resources/import`, 'POST', { uri, collection, title }),
  audit: () => request<AuditEntry[]>('/audit'),
  oauth: (id: string) => request<{ authorization_url?: string; connected?: boolean }>(`${pathFor(id)}/oauth/start`, 'POST'),
}
