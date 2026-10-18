import type { SkippedFile, UploadEntry } from './api'

export function prepareUpload(entries: UploadEntry[]) {
  const supported: UploadEntry[] = [], skipped: SkippedFile[] = []
  for (const entry of entries) {
    const parts = entry.path.replaceAll('\\', '/').split('/')
    let reason = ''
    if (parts.some(part => (part.startsWith('.') && part !== '.' && part !== '..') || /^(thumbs\.db|desktop\.ini|__macosx)$/i.test(part))) reason = 'Hidden or system file'
    else if (!/\.(pdf|docx|txt|md|html?)$/i.test(entry.path)) reason = 'Unsupported file type; supported types: PDF, DOCX, TXT, MD, HTML'
    else if (!entry.file.size) reason = 'File is empty'
    else if (entry.file.size > 50 * 1024 * 1024) reason = 'Each file must be no larger than 50 MB.'
    if (reason) skipped.push({ path: entry.path, reason })
    else supported.push(entry)
  }
  return { supported, skipped }
}

/** Directory readers return batches; keep reading until the empty batch, including nested folders. */
export async function droppedFiles(transfer: DataTransfer): Promise<UploadEntry[]> {
  const out: UploadEntry[] = []
  async function walk(entry: FileSystemEntry, parent = ''): Promise<void> {
    const path = parent + entry.name
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
      out.push({ file, path })
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader()
      while (true) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
        if (!batch.length) break
        for (const child of batch) await walk(child, path + '/')
      }
    }
  }
  const items = Array.from(transfer.items ?? [])
  const entries = items.map(item => item.webkitGetAsEntry?.()).filter((entry): entry is FileSystemEntry => !!entry)
  if (entries.length) {
    for (const entry of entries) await walk(entry)
    return out
  }
  return Array.from(transfer.files).map(file => ({ file, path: file.webkitRelativePath || file.name }))
}
