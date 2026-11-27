// What the host's files.list({ chat, folder, kind, name, offset, limit }) answers (app-files-core `groupFiles`): no folder,
// every entry of the chat; '' what is at the top; 「附件」 by its role; a folder's id, what is directly in it; a folder not
// there, `not-found`. `kind: 'folder'` only folders, `name` names containing it, `limit` a page from `offset` — in the
// order the entries are given here (the database's is the latest change first).
// The folder App reads a chat one folder at a time, so a rig that answers every entry to every read draws them twice.
type Listed = { id: string; name?: string; type?: string; parentId?: string | null; systemRole?: string | null }
type Place = { folder?: string; kind?: 'folder'; name?: string; offset?: number; limit?: number }

export function listedIn<T extends Listed>(entries: readonly T[], place?: Place | null): T[] {
  const folder = place?.folder
  let rows: readonly T[] = entries
  if (folder === '') rows = entries.filter((row) => !row.parentId)
  else if (folder !== undefined) {
    const at = folder === '附件' ? entries.find((row) => row.systemRole === 'attachments' && !row.parentId) : entries.find((row) => row.id === folder)
    if (!at) throw Object.assign(new Error(`找不到文件夹「${folder}」`), { code: 'not-found' })
    rows = entries.filter((row) => row.parentId === at.id)
  }
  if (place?.kind) rows = rows.filter((row) => row.type === 'folder')
  if (place?.name) rows = rows.filter((row) => row.name?.toLowerCase().includes(place.name!.toLowerCase()))
  if (place?.limit !== undefined) rows = rows.slice(place.offset ?? 0, (place.offset ?? 0) + place.limit)
  return rows.map((row) => ({ ...row }))
}
