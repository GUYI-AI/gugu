import { useCallback, useEffect } from 'react'
import type { GroupCollabSnapshot } from '@gugu/core/shared/types/chat'
import { i18n } from '@/i18n'
import { chatService, GroupCollabEmptyError } from '../lib/chat'
import { reconcileGroupCollabSnapshot } from '../lib/groupCollabSnapshot'
import { openedImRepository, openImRepositoryNow, persistableGroupRoster, readGroupRoster, replaceGroupRoster } from '../lib/imRepository'
import { rendererLogger } from '../lib/log'
import { queryClient, replica, useReplica } from '../lib/replica'
import { UI_EVENTS } from '../lib/uiEvents'
import { withTimeout } from '../lib/withTimeout'
import { useAuth } from '../store/auth'
import { useChatStore } from '../store/chatContext'
import { useRoomAuthorityRevision } from './useRoomAuthorityRevision'

const groupCollabLog = rendererLogger('chat/group-collab')

// Outer bound for one getGroupCollab read; the happy path is <500ms.
const GROUP_COLLAB_LOAD_TIMEOUT_MS = 9000

type RoomKind = 'group' | 'topic'

/**
 * A room's roster (群**和话题**都有自己的 chat_members, @@@5856): who is in it, roles, listen modes, the scheduler.
 * The IM library's local copy is the first source for a group; a topic's is not, because whether this viewer still
 * takes part must be confirmed first. Each read publishes identities before the roster: once the roster is shown, @
 * mentions resolve names through identitiesById (mention.ts), so a roster ahead of its identities could not @ a new member.
 * A topic roster with no rows is a conclusion (this viewer no longer takes part), not a fault: `GroupCollabEmptyError`.
 */
export const groupRoster = replica({
  name: 'groupRoster',
  scope: 'account',
  read: async (owner: string, chatId: string, kind: RoomKind): Promise<GroupCollabSnapshot> => {
    const repository = await openedImRepository(owner)
    // A malformed local copy is not a cloud transient: it fails this read loudly, ❌ read around it from the cloud.
    if (kind !== 'topic') readGroupRoster(repository, chatId)
    let load
    try {
      load = await withTimeout(chatService.getGroupCollab(chatId), GROUP_COLLAB_LOAD_TIMEOUT_MS, i18n.t('group.collab.loadTimeout', { ns: 'messaging' }))
    } catch (error) {
      if (error instanceof GroupCollabEmptyError && kind === 'topic') groupCollabLog.info({ chatId }, 'group collab empty topic roster')
      else groupCollabLog.error({ chatId, error }, 'group collab load failed; keeping the shown roster')
      throw error
    }
    const { snapshot, identities } = load
    // A failed local write is logged and the roster still shows: what is on screen does not depend on the local copy (#5610).
    await replaceGroupRoster(repository, chatId, persistableGroupRoster(chatId, snapshot, identities), identities)
      .catch((error) => groupCollabLog.error({ chatId, error }, 'write group roster repository failed'))
    return snapshot
  },
  // The library already open (the chat list draws from it): the local copy is there for the room's first frame.
  local: (owner, chatId, kind) => {
    if (kind === 'topic') return undefined
    const now = openImRepositoryNow(owner)
    return now ? readGroupRoster(now, chatId) ?? undefined : openedImRepository(owner).then((repository) => readGroupRoster(repository, chatId) ?? undefined)
  },
  // Effective membership comes from the backend projection, including removals; survivors keep the order they were drawn in.
  merge: reconcileGroupCollabSnapshot,
})

// An identity that changed may be a member of a roster on screen: read those again.
if (typeof window !== 'undefined') {
  window.addEventListener(UI_EVENTS.identityInvalidated, (event) => {
    const id = (event as CustomEvent<{ id: string | null }>).detail.id
    for (const query of queryClient.getQueryCache().findAll({ queryKey: [groupRoster.name] })) {
      const roster = query.state.data as GroupCollabSnapshot | undefined
      if (id === null || [...(roster?.humans ?? []), ...(roster?.agents ?? [])].some((member) => member.id === id)) {
        void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true })
      }
    }
  })
}

export type RoomCollabError = 'not-participant' | 'failed' | null

/**
 * The room on screen: its roster (null until read, and for a topic this viewer no longer takes part in), whether the
 * last read failed, and the authority revision that its member and collab events bump. `openNonce`: a reopen of the same
 * room (mobile) reads again.
 */
export function useRoomCollab(chatId: string | null, chatKind: RoomKind, sourceChatId: string | null = null, openNonce = 0) {
  const { user } = useAuth()
  const { subscribeAccountRevision } = useChatStore('subscribeAccountRevision')
  const reading = useReplica(groupRoster, chatId ? [chatId, chatKind] : null)
  const reload = useCallback(() => chatId ? groupRoster.refresh(chatId) : Promise.resolve(), [chatId])
  useEffect(() => { if (chatId && openNonce) void groupRoster.refresh(chatId) }, [chatId, openNonce])
  const authorityRevision = useRoomAuthorityRevision({ chatId, sourceChatId, isRoom: !!chatId, userId: user?.id ?? null, loadGroupCollab: reload, subscribeAccountRevision })
  const failure = reading.state === 'error' ? reading.error : reading.state === 'value' ? reading.error : null
  const error: RoomCollabError = !failure ? null : failure instanceof GroupCollabEmptyError && chatKind === 'topic' ? 'not-participant' : 'failed'
  const snapshot = reading.state === 'value' && error !== 'not-participant' ? reading.value : null
  return { snapshot, error, reload, authorityRevision }
}
