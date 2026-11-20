import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react'
import type { GroupInvitation } from '../lib/groupInvitations'
import { rendererLogger } from '../lib/log'
import { contactsService } from '../lib/contacts'
import { contactGroupChatsOf, sharedGroupAgentsOf } from '../lib/contactGroupChats'
import { contactGroups, contactRelations, contactRequests, groupJoinRequests, refreshStrictly, type ContactRelation } from '../lib/contactsReplicas'
import { useReplica, useReplicaFetching } from '../lib/replica'
import { useAuth } from './auth'
import { useChatStore, useStoreValueBy } from './chatContext'
import { UI_EVENTS } from '../lib/uiEvents'
import { ContactsContext, ContactsHandleContext, type ContactsContextValue, type ContactsLoadStatus } from './contactsContext'
import { createSelectStore } from '../lib/selectStore'
import type { ContactGroup, ContactUser, FriendRequest } from '@gugu/core/shared/types/contacts'
import { readRequiredDisplayIdentities } from '../lib/identityReadAdapter'
import type { DisplayIdentity } from '../lib/displayIdentity'
import { managedGroupChats, type ManagedGroupJoinRequest } from '../lib/groupJoinRequests'
import { useIdentityLifecycle } from '../hooks/useIdentityLifecycle'
import { friendRequestEntries } from '../lib/requestHistory'
import { type AgentLook } from '../components/agentAvatar/look'
import { recordContactsRender } from '../lib/perfCounters'
import { myAssistant } from '../lib/myAssistant'
import { reportAssistantAppChange } from '../components/assistant/assistant-app-client'
import { machineRpc } from '../components/session-watch/sessionpage-rpc'
import { renameOwnedAgent } from '../lib/archiveOwnedAgent'
import { i18n } from '../i18n'

const NO_RELATIONS: ContactRelation[] = []
const NO_GROUPS: ContactGroup[] = []
const NO_REQUESTS: FriendRequest[] = []
const NO_INVITATIONS: GroupInvitation[] = []
const NO_JOIN_REQUESTS: ManagedGroupJoinRequest[] = []

// 投影逐行沿用:这一行的内容(身份各格 + 关系四格)与上一次投影出的那个对象一样,就还是那个对象 —— 重拉整张通讯录时
// 每个身份都会被重新 put 成新对象,按引用沿用不住。行组件(memo)凭引用知道「我这一行没变」:改一个 agent 的名字只重画那一行,❌ 整列。
const lastProjected = new Map<string, ContactUser>()
function projectContact(identity: DisplayIdentity, relation: ContactRelation): ContactUser {
  const next: ContactUser = { ...identity, ...relation }
  const previous = lastProjected.get(next.id)
  if (previous && sameFields(previous, next)) return previous
  lastProjected.set(next.id, next)
  return next
}
function sameFields(a: ContactUser, b: ContactUser): boolean {
  const keys = Object.keys(b) as (keyof ContactUser)[]
  return keys.length === Object.keys(a).length && keys.every((key) => Object.is(a[key], b[key]))
}

export function ContactsProvider({ children, active = true }: { children: React.ReactNode; active?: boolean }) {
  const { user: authenticatedUser } = useAuth()
  const userId = active ? authenticatedUser?.id ?? null : null
  const { identitiesById, getImRepository, subscribeAccountRevision, refreshChats, loadingChats, chatsLoadFailed } = useChatStore('identitiesById', 'getImRepository', 'subscribeAccountRevision', 'refreshChats', 'loadingChats', 'chatsLoadFailed')
  // The lists are replicas (lib/contactsReplicas.ts): a reading each, read while signed in; the account boundary is theirs.
  const relationsReading = useReplica(contactRelations, userId ? [] : null)
  const groupsReading = useReplica(contactGroups, userId ? [] : null)
  const requestsReading = useReplica(contactRequests, userId ? [] : null)
  // 「我在哪些群」只有一份:会话投影(chat store 的 chats)。从前这里另拉一张整表(探针 + 全部成员 + 分块 chats + 共享 agent),
  // 每来一条消息(chat_changed)、每次已读(chat_members_changed)都重拉一遍。
  // 每来一条消息 chats 就换一份,而群这几项(名字、成员、角色、免打扰)多半没变:只订阅这几项(@@@select-store),
  // 通讯录(常驻、藏着时也挂着)不跟着每条消息重渲。
  const groupChats = useStoreValueBy((store) => contactGroupChatsOf(store.chats), (store) => contactGroupChatsOf(store.chats))
  // 群里别人的 agent(不是我的、也不在通讯录里):身份就在投影带回来的那份里。
  const sharedGroupAgents = useMemo(() => sharedGroupAgentsOf(groupChats, identitiesById, userId), [groupChats, identitiesById, userId])
  // @@@6418 我管理的群收到的入群申请 —— 与好友申请同归「新的请求」。管理的群集合变了(新建群、被设为管理员、群解散)才重读;
  // 同一组群的其它字段变化不触发。错误单独记,❌ 连累好友申请那一路。
  const managedGroupKey = managedGroupChats(groupChats).map((group) => group.id).sort().join(',')
  const joinRequestsReading = useReplica(groupJoinRequests, userId ? [managedGroupKey] : null)
  // The revision listeners below read the managed groups of the moment they run, ❌ resubscribe when they change.
  const managedGroupKeyRef = useRef(managedGroupKey)
  managedGroupKeyRef.current = managedGroupKey
  const loadingContacts = useReplicaFetching(contactRelations, [])
  const loadingGroups = useReplicaFetching(contactGroups, [])
  // #2118 — contacts / groupChats 各自的加载三态(见 ContactsLoadStatus)。空态 CTA 只在 ready 且为空时出现;一次刷新失败 = error,
  // 旧列表照常画(空列表 + error 显失败与重试,❌ 冒充「没有联系人」)。
  const contactsStatus: ContactsLoadStatus = !userId ? 'idle' : relationsReading.state === 'unknown' ? 'loading'
    : relationsReading.state === 'error' || relationsReading.error ? 'error' : 'ready'
  // #2118 投影读失败 = error(旧行照常画,空着不冒充「没有群」);冷启还没有一行 = loading。
  const groupChatsStatus: ContactsLoadStatus = !userId ? 'idle' : chatsLoadFailed ? 'error' : loadingChats && groupChats.length === 0 ? 'loading' : 'ready'
  const requestsStatus: ContactsLoadStatus = !userId ? 'idle' : requestsReading.state === 'unknown' ? 'loading'
    : requestsReading.state === 'error' || requestsReading.error ? 'error' : 'ready'
  const failureText = (error: Error | null | undefined) => (error ? error.message || String(error) : null)
  const requestsError = requestsReading.state === 'error' ? failureText(requestsReading.error) : requestsReading.state === 'value' ? failureText(requestsReading.error) : null
  const groupJoinRequestsError = joinRequestsReading.state === 'error' ? failureText(joinRequestsReading.error) : joinRequestsReading.state === 'value' ? failureText(joinRequestsReading.error) : null
  // @@@reading-default(paired) - the context pairs each list with its status (#2118: `contactsStatus`, `requestsStatus`, the join requests' `groupJoinRequestsError`): an empty list while it loads is never drawn as "none"
  const contacts = relationsReading.state === 'value' ? relationsReading.value : NO_RELATIONS,
    groups = groupsReading.state === 'value' ? groupsReading.value : NO_GROUPS,
    receivedRequests = requestsReading.state === 'value' ? requestsReading.value.received : NO_REQUESTS,
    sentRequests = requestsReading.state === 'value' ? requestsReading.value.sent : NO_REQUESTS,
    groupInvitations = requestsReading.state === 'value' ? requestsReading.value.invitations : NO_INVITATIONS,
    managedJoinRequests = joinRequestsReading.state === 'value' ? joinRequestsReading.value : NO_JOIN_REQUESTS

  const loadContacts = useCallback(() => contactRelations.refresh(), [])
  const loadGroups = useCallback(() => contactGroups.refresh(), [])
  const loadRequests = useCallback(() => contactRequests.refresh(), [])
  const loadGroupJoinRequests = useCallback(() => groupJoinRequests.refresh(), [])
  const refreshAllRequests = useCallback(async () => {
    await Promise.all([loadRequests(), loadGroupJoinRequests()])
  }, [loadGroupJoinRequests, loadRequests])

  // ── Durable account revision consumers ─────────────────────────────────────
  useEffect(() => {
    if (!userId) return

    // A consumed revision rejects when its read fails (refreshStrictly): the coordinator keeps the event and retries it.
    // @@@chat-projection I7 — 会话列表只有一个属主(chat store 的投影)。本域从前在这几条
    // event 上**另跑一遍** `refreshChats()`,于是同一条通知有两条整表拉取路,派发还把它们串起来
    // (#5394 的 40 环有一段就是这么来的)。现在联系人域只刷**自己拥有**的那几个面,
    // 会话列表交给投影;`chats` 照旧从 chat store 的 context 读。
    // 入群申请也走这一条(gugu-supabase 给群主、管理员和发起人发 friend_requests_changed):同一个「新的请求」收件箱。
    const handleRequestChange = () => Promise.all([
      refreshStrictly(contactRelations),
      refreshStrictly(contactRequests),
      refreshStrictly(groupJoinRequests, managedGroupKeyRef.current),
    ]).then(() => undefined)

    const refreshFriendshipSurfaces = () => Promise.all([
      refreshStrictly(contactRelations),
      refreshStrictly(contactGroups),
      refreshStrictly(contactRequests),
    ]).then(() => undefined)

    // @@@owned-agents-realtime (#671) - reload the owned-agent list when an agent is created/changed,
    // including from another device. 那条新 agent 私聊由投影按键补齐,不再靠整表重拉。
    // agent_provisions writes no revision; a new assistant adds a users row, so `agent_changed` is a hint to read it again.
    const refreshAgentSurfaces = () => { void myAssistant.refresh(); return refreshStrictly(contactRelations) }
    // #6091 会话页「重命名 Agent」改名落在主进程 / 宿主(不经过这里的 updateAgentProfile),通讯录缓存着
    // display_name —— 收到广播就按 agent_changed 同一条路重拉,❌ 挂着旧名等 realtime 兜底。
    const handleOwnedAgentRenamed = () => { void contactRelations.refresh() }
    window.addEventListener(UI_EVENTS.ownedAgentRenamed, handleOwnedAgentRenamed)
    const unsubscribes = [
      subscribeAccountRevision('friend_requests_changed', handleRequestChange),
      subscribeAccountRevision('group_invitations_changed', () => refreshStrictly(contactRequests)),
      subscribeAccountRevision('friendship_changed', refreshFriendshipSurfaces),
      subscribeAccountRevision('agent_changed', refreshAgentSurfaces),
    ]

    return () => {
      window.removeEventListener(UI_EVENTS.ownedAgentRenamed, handleOwnedAgentRenamed)
      for (const unsubscribe of unsubscribes) unsubscribe()
    }
  }, [userId, subscribeAccountRevision])

  useIdentityLifecycle(userId, getImRepository, () => Promise.all([refreshStrictly(contactRelations), refreshChats({ preserveMissingActive: false, throwOnError: true })]),
    () => { const reading = contactRelations.peek(); return reading.state === 'value' ? reading.value.map((relation) => relation.id) : null })

  // ── Actions ────────────────────────────────────────────────────────────────
  const sendRequest = useCallback(
    async (targetUserId: string, message?: string | null) => {
      if (!userId) return
      await contactsService.sendRequest(userId, targetUserId, message)
      await loadRequests()
    },
    [userId, loadRequests],
  )

  const acceptRequest = useCallback(
    async (requestId: string) => {
      const result = await contactsService.acceptRequest(requestId)
      await Promise.all([
        loadContacts(),
        loadRequests(),
        // 接受好友请求只会**多**一段关系:它不携带任何「你失去了某条会话」的消息,不撤销当前选中 (#4314)。
        refreshChats({ acceptEmpty: true }),
      ])
      return result
    },
    [loadContacts, loadRequests, refreshChats],
  )

  const rejectRequest = useCallback(
    async (requestId: string) => {
      await contactsService.rejectRequest(requestId)
      await loadRequests()
    },
    [loadRequests],
  )

  const createGroup = useCallback(
    async (name: string) => {
      if (!userId) return null
      const entry = contactGroups.at()
      const group = await contactsService.createContactGroup(userId, name)
      entry.set((current) => current && [...current, group])
      return group.id
    },
    [userId],
  )

  const renameGroup = useCallback(async (groupId: string, name: string) => {
    const entry = contactGroups.at()
    await contactsService.renameContactGroup(groupId, name)
    entry.set((current) => current?.map((group) => (
      group.id === groupId
        ? { ...group, name: name.trim(), updated_at: new Date().toISOString() }
        : group
    )))
  }, [])

  const deleteGroup = useCallback(async (groupId: string) => {
    const entry = contactGroups.at()
    await contactsService.deleteContactGroup(groupId)
    entry.set((current) => current?.filter((group) => group.id !== groupId))
  }, [])

  const updateContactAlias = useCallback(
    async (contactId: string, alias: string) => {
      if (!userId) return
      const nextAlias = alias.trim() || null
      const entry = contactRelations.at()
      await contactsService.updateContactAlias(userId, contactId, alias)
      entry.set((current) => current?.map((contact) => (
        contact.id === contactId ? { ...contact, alias: nextAlias } : contact
      )))
      await refreshChats()
    },
    [userId, refreshChats],
  )

  const setAgentPublic = useCallback(async (agentId: string, agentPublic: boolean) => {
    const updated = await contactsService.setAgentPublic(agentId, agentPublic)
    await (await getImRepository()).putIdentities([updated])
  }, [getImRepository])

  const setAgentDesiredStatus = useCallback(async (agentId: string, desiredStatus: 'online' | 'offline') => {
    const updated = await contactsService.setAgentDesiredStatus(agentId, desiredStatus)
    await (await getImRepository()).putIdentities([updated])
  }, [getImRepository])

  const applyAgentProfileUpdate = useCallback(async (updated: ContactUser) => (await getImRepository()).putIdentities([updated]), [getImRepository])

  // #1228: update an owned agent's name + bio together (真接 bio — was dropped before).
  // The name is the agent's task name. A task on this device is renamed on its host (renameOwnedAgent, the same rename the
  // tab and the sidebar make), which publishes it and tells the agent; a task elsewhere (maybe off) or none is renamed on
  // the identity here, and the device running the task adopts it. Bio and avatar are the identity's own.
  const updateAgentProfile = useCallback(async (agentId: string, fields: { name?: string; bio?: string; avatar?: string | null }) => {
    const ownerId = userId
    const name = fields.name?.trim()
    if (fields.name !== undefined && !name) throw new Error(i18n.t('errors.nameRequired', { ns: 'contacts' }))
    const renamedOn = name !== undefined ? await renameOwnedAgent(agentId, name) : null
    const renamedOnHost = renamedOn !== null
    const identityFields = {
      ...(name !== undefined && !renamedOnHost ? { display_name: name } : {}),
      ...(fields.bio !== undefined ? { bio: fields.bio } : {}),
      ...(fields.avatar !== undefined ? { avatar: fields.avatar } : {}),
    }
    const updated = Object.keys(identityFields).length > 0 ? await contactsService.updateOwnedAgentProfile(agentId, identityFields) : null
    const deviceId = updated?.device_id ?? renamedOn?.deviceId
    // Decided after the write (a failed assistant read never blocks a profile edit), ❌ guessed from what may not be read yet.
    const personal = !!ownerId && await myAssistant.fetch().then((mine) => mine.agentId === agentId, (error: unknown) => {
      rendererLogger('contacts/profile').error({ error: String(error), agentId }, 'Profile saved; whether it is the assistant could not be read, so the assistant App is not told')
      // @@@reading-default(moment) - a one-moment decision after the write: an assistant identity that cannot be read sends no App note (said in the log)
      return false
    })
    if (personal) await reportAssistantAppChange(deviceId ? { rpc: machineRpc(deviceId) } : null, agentId, {
      resource: 'assistant', operation: 'edited', id: agentId, section: fields.avatar !== undefined ? 'appearance' : 'profile',
      ...(name !== undefined ? { after: { name } } : {}),
    }, ownerId)
    if (updated) await applyAgentProfileUpdate(updated)
    else await contactRelations.refresh()
    await refreshChats()
  }, [applyAgentProfileUpdate, refreshChats, userId])

  // Every name entry uses the profile path (renameOwnedAgent decides where the rename is written).
  const renameAgent = useCallback(async (agentId: string, name: string) => {
    await updateAgentProfile(agentId, { name })
  }, [updateAgentProfile])

  const uploadAgentAvatar = useCallback(async (agentId: string, file: File, profile?: { name?: string; bio?: string }) => {
    // The name (if any) goes the one rename way (updateAgentProfile → renameOwnedAgent); the upload carries the rest.
    if (profile?.name !== undefined) await updateAgentProfile(agentId, { name: profile.name })
    const updated = await contactsService.uploadOwnedAgentAvatar(agentId, file, {
      ...(profile?.bio !== undefined ? { bio: profile.bio } : {}),
    })
    await applyAgentProfileUpdate(updated)
    await refreshChats()
  }, [applyAgentProfileUpdate, refreshChats, updateAgentProfile])

  const setAgentLook = useCallback(async (agentId: string, look: AgentLook) => {
    await updateAgentProfile(agentId, { avatar: contactsService.agentLookAvatarUrl(look) })
  }, [updateAgentProfile])

  /** 删掉一个联系人 / 自家 agent:云端确认后,本地先拿掉它(落在发起删除的那个账号,❌ 换号后的下一个),再按权威数据重读。 */
  const removeContact = useCallback(
    async (contactId: string) => {
      const relations = contactRelations.at()
      const groups = contactGroups.at()
      await contactsService.removeContact(contactId)
      relations.set((current) => current?.filter((contact) => contact.id !== contactId))
      groups.set((current) => current?.map((group) => ({
        ...group,
        contactIds: group.contactIds.filter((id) => id !== contactId),
      })))
      await Promise.all([
        loadContacts(),
        loadGroups(),
        loadRequests(),
        refreshChats({ acceptEmpty: true, preserveMissingActive: false }),
      ])
    },
    [loadContacts, loadGroups, loadRequests, refreshChats],
  )

  const removeOwnedAgent = useCallback(
    async (agentId: string, options?: { removeSocialIdentity?: boolean }) => {
      // The host archive is the receipt: once it resolves the archive happened, and a failed
      // re-read below cannot turn it into a failure. Views reload their authority.
      await contactsService.removeOwnedAgent(agentId, options)
      try {
        await (await getImRepository()).putIdentities(await readRequiredDisplayIdentities([agentId]))
        window.dispatchEvent(new CustomEvent(UI_EVENTS.identityInvalidated, { detail: { id: agentId } }))
        await Promise.all([
          refreshStrictly(contactRelations),
          refreshStrictly(contactGroups),
          refreshChats({ acceptEmpty: true, preserveMissingActive: false, throwOnError: true }),
        ])
      } catch (error) {
        rendererLogger('contacts/archive').error({ error, agentId }, 'Archived agent; refreshing contacts and chats failed')
      }
    },
    [getImRepository, refreshChats],
  )

  // 值只在它自己的输入变了时才换:从前每次渲染新建一份(连同按身份投影的几百个联系人),每个读通讯录的组件跟着重渲染。
  const value = useMemo(() => {
    recordContactsRender()
    const requireIdentity = (id: string) => { const identity = identitiesById[id]; if (!identity) throw new Error(`Missing committed identity ${id}`); return identity }
    const project = (rows: ContactRelation[]) => rows.map((relation) => projectContact(requireIdentity(relation.id), relation))
    const withPeers = (rows: FriendRequest[]) => rows.map((request) => ({ ...request, sender: identitiesById[request.sender_id], receiver: identitiesById[request.receiver_id] }))
    return {
      contacts: project(contacts),
      sharedGroupAgents,
      groups,
      groupChats,
      friendRequests: friendRequestEntries(withPeers(receivedRequests), withPeers(sentRequests)),
      groupInvitations,
      groupJoinRequests: managedJoinRequests,
      groupJoinRequestsError,
      pendingRequestCount: [...receivedRequests, ...groupInvitations, ...managedJoinRequests].filter((request) => request.status === 'pending').length,
      requestsStatus,
      requestsError,
      sentRequests: withPeers(sentRequests.filter((request) => request.status === 'pending')),
      loadingContacts,
      loadingGroups,
      contactsStatus,
      groupChatsStatus,
      sendRequest,
      acceptRequest,
      rejectRequest,
      refreshContacts: loadContacts,
      refreshGroups: loadGroups,
      refreshRequests: refreshAllRequests,
      refreshGroupJoinRequests: loadGroupJoinRequests,
      createGroup,
      renameGroup,
      deleteGroup,
      updateContactAlias,
      setAgentPublic,
      setAgentDesiredStatus,
      renameAgent,
      updateAgentProfile,
      uploadAgentAvatar,
      setAgentLook,
      removeOwnedAgent,
      removeContact,
    }
  }, [
    contacts, identitiesById, sharedGroupAgents, groups, groupChats, receivedRequests, sentRequests,
    groupInvitations, managedJoinRequests, groupJoinRequestsError, requestsStatus, requestsError, loadingContacts,
    loadingGroups, contactsStatus, groupChatsStatus, sendRequest, acceptRequest,
    rejectRequest, loadContacts, loadGroups, refreshAllRequests, loadGroupJoinRequests, createGroup, renameGroup,
    deleteGroup, updateContactAlias, setAgentPublic, setAgentDesiredStatus, renameAgent,
    updateAgentProfile, uploadAgentAvatar, setAgentLook, removeOwnedAgent, removeContact,
  ])
  const [store] = useState(() => createSelectStore<ContactsContextValue>(value))
  store.publish(value)
  useLayoutEffect(() => { store.notify() }, [store, value])
  return <ContactsHandleContext.Provider value={store}><ContactsContext.Provider value={value}>{children}</ContactsContext.Provider></ContactsHandleContext.Provider>
}
