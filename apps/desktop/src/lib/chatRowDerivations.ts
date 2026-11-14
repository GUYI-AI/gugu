import type { AgentDisplayStatus, ChatItem } from '@gugu/core/shared/types/chat'
import type { DisplayIdentity } from './displayIdentity'
import type { IdentityDirectorySnapshot } from './identityDirectoryBridge'
import { replaceEqualDeep } from '@tanstack/react-query'
import { memoizeByReference } from './memoizeByReference'

type MembershipParts = { group: string | null; peer: string | null }

/** Archival hides an owned Agent's ordinary list row, without changing its addressable history. */
export function isArchivedOwnedAgentChat(
  chat: Pick<ChatItem, 'kind'>,
  ownerId: string | undefined,
  peer: DisplayIdentity | undefined,
  status?: AgentDisplayStatus,
): boolean {
  return (chat.kind === 'dm' || chat.kind === 'ai') && !!ownerId && peer?.type === 'agent'
    && peer.owner_user_id === ownerId && (peer.session_archived_at != null || status === 'archived')
}

/** Activity can reorder rows without changing any membership. Only rebuild aggregate strings/ids when parts change. */
export function createChatMembershipProjection() {
  let held: Record<string, MembershipParts> = {}
  const partsOf = memoizeByReference((chat: ChatItem, directory: IdentityDirectorySnapshot) => {
    const ids = chat.member_user_ids ?? [], peer = chat.peer_user_id
    return replaceEqualDeep(held[chat.id], { group: chat.kind === 'group' ? `${chat.id}:${[...ids].sort().join(',')}` : null,
      peer: (chat.kind === 'dm' || chat.kind === 'ai') && peer && directory[peer]?.type === 'agent' ? peer : null })
  })
  let result = { key: '', agentIds: [] as string[] }
  return (chats: readonly ChatItem[], directory: IdentityDirectorySnapshot) => {
    const next = Object.fromEntries(chats.map(chat => [chat.id, partsOf(chat, directory)]))
    if (replaceEqualDeep(held, next) !== held) {
      held = next
      const parts = Object.values(next)
      result = { key: parts.flatMap(part => part.group === null ? [] : [part.group]).sort().join('|'),
        agentIds: parts.flatMap(part => part.peer ?? []).sort() }
    }
    return result
  }
}
