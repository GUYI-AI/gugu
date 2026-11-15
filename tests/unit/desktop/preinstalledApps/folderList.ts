// What the host's files.list({ chat, folder }) answers (app-files-core `groupFiles`): no folder, every entry of the chat;
// '' what is at the top; 「附件」 by its role; a folder's id, what is directly in it; a folder not there, `not-found`.
// The folder App reads a chat one folder at a time, so a rig that answers every entry to every read draws them twice.
type Listed = { id: string; parentId?: string | null; systemRole?: string | null }

export function listedIn<T extends Listed>(entries: readonly T[], place?: { folder?: string } | null): T[] {
  const folder = place?.folder
  const copies = (rows: readonly T[]) => rows.map((row) => ({ ...row }))
  if (folder === undefined) return copies(entries)
  if (folder === '') return copies(entries.filter((row) => !row.parentId))
  const at = folder === '附件' ? entries.find((row) => row.systemRole === 'attachments' && !row.parentId) : entries.find((row) => row.id === folder)
  if (!at) throw Object.assign(new Error(`找不到文件夹「${folder}」`), { code: 'not-found' })
  return copies(entries.filter((row) => row.parentId === at.id))
}
