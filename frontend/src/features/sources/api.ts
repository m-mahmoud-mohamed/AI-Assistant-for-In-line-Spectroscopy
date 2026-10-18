/** Source management owns its client; multipart bodies must keep the browser's boundary header. */
export type SourceKind = 'UPLOAD' | 'WEB' | 'MCP' | 'MCP_LIVE'
export interface Collection { id: string; name: string; sources: number }
export interface Job {
  id: string; source_id: string | null; title: string
  status: 'queued' | 'extracting' | 'chunking' | 'indexing' | 'ready' | 'failed'
  progress: number; error: string; duplicate: boolean
}
export interface Source {
  id: string; collection: string; title: string; kind: SourceKind; filename: string; relative_path: string
  mime: string; size: number; sha256: string; pages: number; chunks: number; added_at: string
  status: Job['status']; error: string; canonical_url: string | null; origin: Record<string, string>
}
export interface SourceDetail extends Source {
  preview: { page: number; text: string; truncated: boolean }[]; preview_truncated: boolean
}
export interface UploadEntry { file: File; path: string }
const base = '/api/sources'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(base + path, init)
  if (!response.ok) {
    let detail = `Source request failed (${response.status})`
    try {
      const body = await response.json() as { detail?: unknown }
      if (typeof body.detail === 'string') detail = body.detail
    } catch { /* Keep the HTTP status when a proxy returns a non-JSON error. */ }
    throw new Error(detail)
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
export const sourcesApi = {
  collections: () => request<Collection[]>('/collections'),
  createCollection: (name: string) => request<Collection>('/collections', json('POST', { name })),
  renameCollection: (id: string, name: string) => request<Collection>(`/collections/${encodeURIComponent(id)}`, json('PATCH', { name })),
  deleteCollection: (id: string) => request<void>(`/collections/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  list: (collection: string, offset = 0) => request<{ items: Source[]; total: number }>(`/sources?limit=25&offset=${offset}${collection ? `&collection=${encodeURIComponent(collection)}` : ''}`),
  detail: (id: string) => request<SourceDetail>(`/sources/${encodeURIComponent(id)}`),
  remove: (id: string) => request<void>(`/sources/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  reindex: (id?: string) => request<{ jobs: Job[] } | Job>(id ? `/sources/${encodeURIComponent(id)}/reindex` : '/reindex', { method: 'POST' }),
  job: (id: string) => request<Job>(`/jobs/${encodeURIComponent(id)}`),
  urls: (collection: string, urls: string[]) => request<{ jobs: Job[] }>('/urls', json('POST', { collection, urls })),
  upload: (collection: string, entries: UploadEntry[]) => {
    const body = new FormData()
    body.append('collection', collection)
    body.append('relative_paths', JSON.stringify(entries.map(e => e.path)))
    entries.forEach(e => body.append('files', e.file, e.file.name))
    return request<{ jobs: Job[] }>('/upload', { method: 'POST', body })
  },
}
