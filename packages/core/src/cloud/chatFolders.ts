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

/** One folder as a device publishes it to the account. */
export type PublishedFolder = { folderId: string; chatId: string; path: string; attachedAt: string | null }

export interface ChatFoldersPublishClient {
  rpc(fn: 'publish_chat_folders', args: { p_device_id: string; p_folders: unknown[] }): { abortSignal?(signal: AbortSignal): PromiseLike<RpcResult> } & PromiseLike<RpcResult>
}

/** What the account made of a publish: whether its copy changed, and the folders whose group it refused. */
export type ChatFoldersPublished = { changed: boolean; rejected: string[] }

/** This device's whole folder set onto the account (folders not listed are unbound there). */
export async function publishChatFolders(client: ChatFoldersPublishClient, deviceId: string, folders: readonly PublishedFolder[],
  signal?: AbortSignal): Promise<ChatFoldersPublished> {
  const request = client.rpc('publish_chat_folders', {
    p_device_id: deviceId,
    p_folders: folders.map((folder) => ({ folder_id: folder.folderId, chat_id: folder.chatId, path: folder.path, attached_at: folder.attachedAt })),
  })
  const { data, error } = await (signal && request.abortSignal ? request.abortSignal(signal) : request)
  if (error) throw new Error(error.message)
  const reply = data as { changed?: unknown; rejected?: unknown } | null
  if (typeof reply?.changed !== 'boolean' || !Array.isArray(reply.rejected) || !reply.rejected.every((id) => typeof id === 'string' && id)) {
    throw new Error('Folder publish response must be {changed, rejected}')
  }
  return { changed: reply.changed, rejected: reply.rejected as string[] }
}
