import type { UploadEntry } from './api'

/** Directory readers return batches; keep reading until the empty batch, including nested folders. */
export async function droppedFiles(transfer: DataTransfer): Promise<UploadEntry[]> {
  const out: UploadEntry[] = []
  async function walk(entry: FileSystemEntry, parent = ''): Promise<void> {
    const path = parent + entry.name
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
      out.push({ file, path })
      if (out.length > 100) throw new Error('Choose no more than 100 files per batch.')
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
