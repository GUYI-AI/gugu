/**
 * @@@group-folders — the account's folders by group (identity.my_chat_folders, gugu-supabase 20261120100000): every
 * folder one of the caller's devices binds to a group, including devices that are offline now. Only the binding
 * account reads them. One unreadable row makes the whole list unreadable (❌ silently dropping a folder).
 */
type RpcResult = { data: unknown; error: { message: string } | null }

export type AccountGroupFolders = {
  chatId: string
  name: string
  archived: boolean
  /** The group's last activity (last message, else creation), ISO. */
  activeAt: string
  folders: Array<{ deviceId: string; folderId: string; path: string; position: number; attachedAt: string | null; removalRequestedAt: string | null }>
}

export interface ChatFoldersRpcClient {
  rpc(fn: 'my_chat_folders'): PromiseLike<RpcResult>
}

const text = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value) throw new Error(`Group folder row has no ${field}`)
  return value
}
const optionalTime = (value: unknown, field: string): string | null => {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`Group folder row has an invalid ${field}`)
  return value
}

export async function listMyChatFolders(client: ChatFoldersRpcClient): Promise<AccountGroupFolders[]> {
  const { data, error } = await client.rpc('my_chat_folders')
  if (error) throw new Error(error.message)
  if (!Array.isArray(data)) throw new Error('Group folder list response must be an array')
  return data.map((row) => {
    const value = row as Record<string, unknown>
    const active = optionalTime(value.last_message_at, 'last_message_at')
    const folders = value.folders
    if (!Array.isArray(folders)) throw new Error('Group folder row has no folder list')
    return {
      chatId: text(value.chat_id, 'chat_id'),
      name: typeof value.name === 'string' ? value.name : '',
      archived: value.status === 'archived',
      activeAt: active ?? new Date(0).toISOString(),
      folders: folders.map((entry) => {
        const f = entry as Record<string, unknown>
        if (!Number.isSafeInteger(f.position)) throw new Error('Group folder row has no position')
        return {
          deviceId: text(f.device_id, 'device_id'), folderId: text(f.folder_id, 'folder_id'), path: text(f.path, 'path'),
          position: f.position as number, attachedAt: optionalTime(f.attached_at, 'attached_at'),
          removalRequestedAt: optionalTime(f.removal_requested_at, 'removal_requested_at'),
        }
      }),
    }
  })
}
