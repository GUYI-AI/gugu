import type { ChatItem, MessageItem } from '@gugu/core/shared/types/chat'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { compareChatsByActivityDesc, isChatListed, isRoomChat } from '@gugu/core/shared/ui/chatModels'
import type { ChatPickRow } from './ChatPickSheet'
import { groupTopicsBySource, isTopLevelChatRow, isTopicRow, splitSunkTopics } from '../chatListTopicNesting'
import { parseWidgetMessage } from '@gugu/core/shared/ui/widgetModels'

/** Compact, non-text-content preview label for the forwarded message. */
export function forwardPreview(
  message: Pick<MessageItem, 'content' | 'content_type'>,
  labels: { attachment: string; card: string; empty: string },
): string {
  if (message.content_type === 'attachment') return labels.attachment
  if (message.content_type === 'card') return labels.card
  if (message.content_type === 'widget') return parseWidgetMessage(message.content)?.text ?? '[Widget]'
  const text = message.content?.trim()
  return text && text.length > 0 ? text : labels.empty
}

type Identity = { display_name: string; avatar: string | null; type?: string; owner_user_id?: string | null; session_archived_at?: string | null }
type Identities = Readonly<Record<string, Identity | undefined>>

/** A chat as a row, by the name the caller gives it (its own for a group or topic, the peer's for a private chat). */
export function chatPickRow(chat: ChatItem, name: string, identitiesById: Identities): ChatPickRow {
  const identity = identitiesById[chat.peer_user_id ?? '']
  return {
    id: chat.id,
    name,
    // @@@2470 群没有 peer_user_id：不标 variant='group' 会被判成「缺身份 key 的人」，
    // 每次渲染刷一条诊断（agent e2e 的 console 守卫会当场失败）。口径同 ChatListPanel。
    avatar: chat.kind === 'topic' ? undefined : {
      name,
      avatarUrl: isRoomChat(chat.kind) ? chat.avatar : identity?.avatar,
      seed: isRoomChat(chat.kind) ? chat.id : chat.peer_user_id ?? undefined,
      isAgent: identity?.type === 'agent',
      variant: isRoomChat(chat.kind) ? 'group' : 'default',
    },
  }
}

export interface SendableQuery {
  /** The signed-in account: whose agents are «own». */
  ownerId: string | undefined
  /** Left out: the chat a forward comes from. */
  sourceChatId?: string
  query: string
  displayName: (chat: ChatItem) => string
  identitiesById: Identities
  /** Topics under their group (forwarding, dispatch); off where a topic is no place to land (a share's draft). */
  topics?: boolean
  /** The chat list's own exceptions to «an empty private chat is not listed»: the one open, one with a draft. */
  activeChatId?: string | null
  drafts?: Readonly<Record<string, string>>
}

export interface Sendable {
  /** Top-level conversations, pinned first, then the latest first; a topic stands here only when its group is not offered. */
  chats: ChatItem[]
  /** Each group's topics offered under it, the latest first. */
  topicsOf: ReadonlyMap<string, ChatItem[]>
  /** Every chat by id: names the group of a topic that stands alone. */
  byId: ReadonlyMap<string, ChatItem>
}

/** An owned agent archived away: the chat list does not draw it, and nothing is sent to it. */
function archivedOwnAgent(chat: ChatItem, q: SendableQuery): boolean {
  const peer = q.identitiesById[chat.peer_user_id ?? '']
  return (chat.kind === 'dm' || chat.kind === 'ai') && !!q.ownerId && peer?.type === 'agent' && peer.owner_user_id === q.ownerId && peer.session_archived_at != null
}

/**
 * The conversations this account can send into, as the chat list lists them: a private chat that has never been
 * talked in is listed only once it is searched for (isChatListed); an archived own agent is not; topics hang under their
 * group. One list for every «send to» page: forwarding, a share's 「发送到」, an App's dispatch.
 */
export function sendableConversations(chats: readonly ChatItem[], q: SendableQuery): Sendable {
  const needle = q.query.trim().toLocaleLowerCase()
  const matches = (chat: ChatItem) => !needle || q.displayName(chat).toLocaleLowerCase().includes(needle)
  const listed = (chat: ChatItem) => chat.id !== q.sourceChatId && !archivedOwnAgent(chat, q) && (q.topics !== false || !isTopicRow(chat))
    && (needle ? true : isChatListed(chat, { activeChatId: q.activeChatId, hasDraft: Boolean(q.drafts?.[chat.id]?.trim()) }))
  const byId = new Map(chats.map((chat) => [chat.id, chat]))
  const offered = (chat: ChatItem) => listed(chat) && matches(chat)
  const nesting = groupTopicsBySource(chats, offered, compareChatsByActivityDesc, (id) => { const group = byId.get(id); return !!group && listed(group) })
  const top = chats.filter((chat) => isTopLevelChatRow(chat, nesting, listed, matches))
    .sort((a, b) => Number(Boolean(b.is_pinned)) - Number(Boolean(a.is_pinned)) || compareChatsByActivityDesc(a, b))
  return { chats: top, topicsOf: nesting.bySource, byId }
}

/**
 * The people this account can write to who have no conversation above: friends, and its own agents, not archived. A
 * pick of one is `person:<id>`; the private chat is found, or opened, when the forward is sent (useResolveTargets).
 */
export function sendablePeople(contacts: readonly ContactUser[], shown: readonly ChatItem[], q: Pick<SendableQuery, 'ownerId' | 'query'>): ContactUser[] {
  const needle = q.query.trim().toLocaleLowerCase()
  const inList = new Set(shown.flatMap((chat) => (chat.kind === 'dm' || chat.kind === 'ai') && chat.peer_user_id ? [chat.peer_user_id] : []))
  return contacts.filter((contact) => contact.id !== q.ownerId && !contact.removed_at && !inList.has(contact.id)
    && (contact.type !== 'agent' || (!!q.ownerId && contact.owner_user_id === q.ownerId && !contact.session_archived_at))
    && (!needle || `${contact.alias ?? ''} ${contact.display_name}`.toLocaleLowerCase().includes(needle)))
}

export const PERSON_ROW = 'person:'

/**
 * The rows a pick offers. A group shows its latest topics (the chat list's TOPIC_SUBROW_LIMIT, unread ones always) and
 * counts the rest on a 「还有 N 个话题」 row, until `expanded` has it; a search shows every topic it finds. `idOf` is the row
 * id a caller keys its pick by.
 */
export function sendablePickRows(
  sendable: Sendable,
  displayName: (chat: ChatItem) => string,
  identitiesById: Identities,
  options: { expanded?: ReadonlySet<string>; searching?: boolean; idOf?: (id: string) => string } = {},
): ChatPickRow[] {
  const idOf = options.idOf ?? ((id: string) => id)
  const row = (chat: ChatItem): ChatPickRow => ({ ...chatPickRow(chat, displayName(chat), identitiesById), id: idOf(chat.id) })
  return sendable.chats.map((chat) => {
    const group = isTopicRow(chat) ? sendable.byId.get(chat.source_chat_id ?? '') : undefined
    const all = sendable.topicsOf.get(chat.id) ?? []
    const { live, sunk } = splitSunkTopics(all, () => false, undefined, options.searching === true || options.expanded?.has(chat.id) === true)
    return { ...row(chat), hint: group && displayName(group), topics: live.length ? live.map(row) : undefined, moreTopics: sunk.length || undefined }
  })
}

/** A person with no conversation yet, as a row. */
export function personPickRow(contact: ContactUser): ChatPickRow {
  const name = contact.alias || contact.display_name
  return { id: `${PERSON_ROW}${contact.id}`, name, avatar: { name, avatarUrl: contact.avatar, seed: contact.id, isAgent: contact.type === 'agent' } }
}
