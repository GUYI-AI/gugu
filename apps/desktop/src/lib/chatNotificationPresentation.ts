// #3416 What an operating-system chat notification shows about who spoke: the conversation's face (a direct chat's
// other person, a group's own picture) and the message author as a person of their own. Resolved from the same sources
// the chat list draws (the identity directory, the chat row's `avatar`) — no second identity rule, and never from
// parsing a title. Pictures arrive as drawn bitmaps (chatNotificationFaces.ts); this file only decides whose.
import { isRoomChat } from '@gugu/core/shared/ui/chatModels'
import type { ChatItem, MessageItem } from '@gugu/core/shared/types/chat'
import { rendererLogger } from '@/lib/log'
import type { DisplayIdentity } from './displayIdentity'
import type { ChatNotificationPresentation } from '../platform/types'

const log = rendererLogger('chat-notification-presentation')

/** Where the faces and names come from. A face that cannot be drawn is `null`: the notification then says so. */
export interface PresentationSources {
  /** The directory's identity for an id; `null` when it is not known (yet), a deleted account included. */
  identity(id: string): Promise<DisplayIdentity | null>
  /** Someone's face: their picture, else their stable-id default. `null` = cannot be drawn. */
  userFace(identity: DisplayIdentity): Promise<string | null>
  /** A group's (or topic's) face: its own picture, else the default group face seeded by its id. */
  groupFace(group: { id: string; name: string; avatar: string | null }): Promise<string | null>
}

export interface PresentedMessage {
  presentation: ChatNotificationPresentation
  /**
   * Set when something was still being drawn at `budgetMs`: the presentation went out without it. Resolves to the same
   * message with what was drawn since, marked `update` — the caller refreshes the notification that is still showing,
   * without alerting again. `null` when nothing was late.
   */
  refresh: Promise<ChatNotificationPresentation> | null
}

type Settled = { conversationFace: string | null; authorName: string; authorFace: string | null }

/** Swallow one source's failure so the notification still goes out; the reason is logged without any URL. */
async function guarded<T>(what: string, read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read()
  } catch (error) {
    log.error({ what, error: error instanceof Error ? error.name : 'unknown' }, 'chat notification source failed')
    return fallback
  }
}

export async function presentChatMessage(
  input: { accountId: string; chat: ChatItem; message: MessageItem; title: string },
  sources: PresentationSources,
  budgetMs: number,
): Promise<PresentedMessage> {
  const { accountId, chat, message, title } = input
  const room = isRoomChat(chat.kind)
  const authorId = message.sender_user_id
  const identityOf = (id: string | null | undefined) =>
    id ? guarded('identity', () => sources.identity(id), null) : Promise.resolve(null)
  const faceOf = (identity: DisplayIdentity | null) =>
    identity ? guarded('face', () => sources.userFace(identity), null) : Promise.resolve(null)

  const author = identityOf(authorId)
  const authorFace = author.then(faceOf)
  // The chat list's own rule (ChatListPanel): a room shows the room's picture, a peer chat shows the peer — the row's
  // `avatar` is empty for peers on purpose, and a topic is a room of its own.
  const conversationFace: Promise<string | null> = room
    ? guarded('group face', () => sources.groupFace({ id: chat.id, name: title, avatar: chat.avatar ?? null }), null)
    : (chat.peer_user_id === authorId ? authorFace : identityOf(chat.peer_user_id).then(faceOf))

  // Each part lands in `known` as it arrives, so what was ready at the budget goes out and only the rest is refreshed.
  const known: Settled = { conversationFace: null, authorName: '', authorFace: null }
  const settled = Promise.all([
    author.then((identity) => { known.authorName = identity?.display_name ?? '' }),
    authorFace.then((face) => { known.authorFace = face }),
    conversationFace.then((face) => { known.conversationFace = face }),
  ])
  const present = (s: Settled, update: boolean): ChatNotificationPresentation => ({
    accountId,
    messageId: message.id,
    sentAt: Date.parse(message.created_at),
    conversation: { id: chat.id, kind: room ? 'group' : 'dm', name: title, avatar: s.conversationFace },
    author: { id: authorId, name: s.authorName, avatar: s.authorFace },
    ...(update ? { update: true as const } : {}),
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), budgetMs) })
  const inTime = await Promise.race([settled.then(() => true as const), timedOut])
  clearTimeout(timer)
  if (inTime) return { presentation: present(known, false), refresh: null }
  // Nothing is claimed that was not read: a face still being drawn is `null`, the unavailable state, until the refresh.
  return { presentation: present({ ...known }, false), refresh: settled.then(() => present({ ...known }, true)) }
}
