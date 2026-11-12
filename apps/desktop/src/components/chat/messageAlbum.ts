import type { MessageItem } from '@gugu/core/shared/types/chat'

// #2581 Files sent at once are one message: each file keeps its own row (upload, failure, resend stay per file) and the
// rows of one send share send_group_id. The list draws a send as its first row, which stands for all of them.

/** Which send a row belongs to: same sender, same conversation, same send. None for a message sent on its own. */
function sendKey(message: MessageItem): string | null {
  if (!message.send_group_id || !message.send_group_size || !message.sender_user_id || message.content_type !== 'attachment') return null
  return `${message.chat_id}\u0000${message.sender_user_id}\u0000${message.send_group_id}`
}

/** Every drawn send by the id of the row that stands for it, its rows in the order they were sent. */
export type MessageAlbums = ReadonlyMap<string, readonly MessageItem[]>
const NO_ALBUMS: MessageAlbums = new Map()

/**
 * Collapses the rows of each send into its first one. That row is replaced by the send as a whole: its send state is the
 * worst of the files' (one failed ⇒ failed). A send of which only one row is here is drawn as that row.
 */
export function collapseSendGroups<Row extends { type: string; message: MessageItem }>(rows: readonly Row[]): { rows: readonly Row[]; albums: MessageAlbums } {
  const byKey = new Map<string, MessageItem[]>()
  let grouped = false
  for (const row of rows) {
    const key = row.type === 'message' ? sendKey(row.message) : null
    if (!key) continue
    const members = byKey.get(key)
    if (members) { members.push(row.message); grouped = true } else byKey.set(key, [row.message])
  }
  if (!grouped) return { rows, albums: NO_ALBUMS }
  const albums = new Map<string, readonly MessageItem[]>()
  const drawn: Row[] = []
  for (const row of rows) {
    const key = row.type === 'message' ? sendKey(row.message) : null
    const members = key ? byKey.get(key)! : null
    if (!members || members.length < 2) { drawn.push(row); continue }
    if (members[0] !== row.message) continue
    albums.set(row.message.id, members)
    drawn.push({ ...row, message: sendAsOneMessage(members) })
  }
  return { rows: drawn, albums }
}

/** The send drawn as one message: its first row, with the send state of all its files. */
function sendAsOneMessage(members: readonly MessageItem[]): MessageItem {
  const first = members[0]!
  const failed = members.filter(member => member.local_send_state === 'failed')
  if (failed.length) {
    return { ...first, local_send_state: 'failed', local_send_error: failed[0]!.local_send_error ?? null,
      local_send_retryable: failed.some(member => member.local_send_retryable !== false) }
  }
  if (members.some(member => member.local_send_state === 'sending')) return { ...first, local_send_state: 'sending' }
  return first
}

/** The row that marks the send read: the last one that reached the conversation. */
export function newestDelivered(members: readonly MessageItem[]): MessageItem {
  return members.reduce((newest, member) => member.seq > newest.seq ? member : newest, members[0]!)
}

/** The same sends with the same rows: the list keeps the albums it had, so a new message elsewhere re-renders no album. */
export function sameAlbums(a: MessageAlbums, b: MessageAlbums): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const [id, members] of a) {
    const next = b.get(id)
    if (!next || next.length !== members.length || next.some((member, index) => member !== members[index])) return false
  }
  return true
}
