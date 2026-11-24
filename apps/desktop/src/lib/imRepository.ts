import { replaceEqualDeep } from '@tanstack/react-query'
import { memoizeByReference } from './memoizeByReference'
import type { CommitArgs } from '@gugu/core/cloud/attachmentsApi'
import type { CreateTopicInput } from './topics'
import type {
  ChatItem,
  GroupAgentItem,
  GroupCollabSnapshot,
  GroupMemberItem,
  GroupSchedulerState,
  MessageItem,
} from '@gugu/core/shared/types/chat'
import { displayIdentityFromRow, type DisplayIdentity } from './displayIdentity'
import { recordImTransaction } from './perfCounters'
import { assertIdentityClosure } from './identityClosure'
import { resolveListenModeDefault } from '@gugu/core/cloud/listenMode'
import { rendererLogger } from './log'
import { initializeMessages, ingestMessages } from './messageIngest'
import { messageWindow } from './messageWindows'
import { compareChatsByActivityDesc } from '@gugu/core/shared/ui/chatModels'
import { captureMessagePosition } from '@gugu/core/shared/ui/messageTimeline'
import {
  IM_STORE_NAMES,
  migrateLegacyChatList,
  openLocalSyncDb,
  type ImStoreName,
  type LocalImDbAdapter,
  type LocalImDbOperation,
  type LocalImRow,
} from './localSyncDb'

type EntityValue = Record<string, unknown>
const repositoryLog = rendererLogger('im/repository')

export type IdentityRow = LocalImRow & { id: string; value: DisplayIdentity }
export type ChatRow = LocalImRow & { id: string; value: ChatItem }
type ChatRowChanges = { changed: readonly ChatItem[]; deleted: readonly string[] }
export type MembershipRow = LocalImRow & { chatId: string; identityId: string; value: EntityValue }
export type PresenceRow = LocalImRow & { identityId: string; value: EntityValue }
export type OutboxRow = LocalImRow & { id: string; value: OutboxRecord }
export type ViewRow = LocalImRow & { key: string; value: unknown }
export type SyncStateRow = LocalImRow & { key: string; value: unknown }

export type OutboxOperation =
  | { kind: 'message' }
  | { kind: 'upload' }
  | { kind: 'nativeAttachment'; commit: Omit<CommitArgs, 'staging_key'> }
  | { kind: 'forward'; source: { kind: 'message'; id: string } | { kind: 'file'; id: string; version: number | null } }
  | { kind: 'attachment'; commit: CommitArgs }
  | { kind: 'topic'; input: CreateTopicInput & { topicId: string } }

export interface OutboxRecord {
  /** Missing on older durable text records. */
  operation?: OutboxOperation
  preview?: Pick<MessageItem, 'file_item_id' | 'file_version' | 'file_blob_id' | 'file_metadata' | 'image_dimensions' | 'send_group_id' | 'send_group_size' | 'annotations' | 'local_timeline'>
  clientMessageId: string
  chatId: string
  senderUserId: string
  payload: {
    content: string
    contentType: string
    toUserIds: string[] | null
    replyToMessageId: string | null
    threadRootId: string | null
    isThreadRoot: boolean
    isWhisper: boolean
    /** 私聊发送时对端尚未就绪:投递前由 outbox 的 prepare 解析对端并写回 toUserIds(#1554,C2)。 */
    resolveDmPeer?: boolean
  }
  /** Local source dependency, preserved across restarts. */
  dependsOn?: string
  dependencyDiscarded?: boolean
  state: 'pending' | 'sending' | 'failed' | 'uploading'
  attempts: number
  lastError: string | null
  enqueuedAt: string
  updatedAt: string
}

export interface ImRepositorySnapshot {
  identity: readonly IdentityRow[]
  chat: readonly ChatRow[]
  membership: readonly MembershipRow[]
  presence: readonly PresenceRow[]
  outbox: readonly OutboxRow[]
  view: readonly ViewRow[]
  sync_state: readonly SyncStateRow[]
}

type MutableSnapshot = { [Store in ImStoreName]: LocalImRow[] }
type Selector<T> = (snapshot: ImRepositorySnapshot) => T
type Listener<T> = (value: T, snapshot: ImRepositorySnapshot) => void

export interface ImRepositoryTransaction {
  clear(): void
  putIdentity(value: unknown): void
  putChat(id: string, value: ChatItem): void
  putMembership(chatId: string, identityId: string, value: EntityValue): void
  readView(key: string): unknown
  putPresence(identityId: string, value: EntityValue): void
  putView(key: string, value: unknown): void
  putSyncState(key: string, value: unknown): void
  delete(store: ImStoreName, key: IDBValidKey): void
}

export interface AccountImRepository {
  readonly accountId: string
  snapshot(): ImRepositorySnapshot
  transaction<T>(mutate: (transaction: ImRepositoryTransaction) => T | Promise<T>): Promise<T>
  putIdentities(rows: readonly unknown[]): Promise<void>
  subscribe<T>(selector: Selector<T>, listener: Listener<T>): () => void
  reset(): Promise<void>
  close(): void
}

/**
 * @@@table-selector — 只读一张表的选择器:那张表还是上一次那个对象(这次事务没碰它,见 applyOperations),就交回上一次的结果。
 * 每次事务都会把每个订阅的选择器跑一遍;从前这里每次都新建一份身份表 / 会话列表,任何一次写(同步游标、一条消息)都让
 * 订阅身份或会话列表的每个组件整页重渲染 —— 藏着的通讯录随之每秒重画几百行(Chole 10-20 实测,渲染进程内存一路涨)。
 */
function fromTable<S extends ImStoreName, T>(store: S, derive: (rows: ImRepositorySnapshot[S]) => T): Selector<T> {
  const project = memoizeByReference(derive)
  return snapshot => project(snapshot[store], undefined)
}

export const imSelectors = {
  identitiesById: fromTable('identity', (rows) => Object.freeze(Object.fromEntries(
    rows.map((row) => [row.id, row.value]),
  )) as Readonly<Record<string, DisplayIdentity>>),
  // List order is the projection's (activity, then id); it is sorted here, on a read, not stored per row — a stored
  // position would make one moved conversation rewrite every row below it.
  chats: fromTable('chat', (rows) => rows
    .map((row) => row.value)
    .sort(compareChatsByActivityDesc)),
  chatRowsById: fromTable('chat', (rows) => new Map(rows.map(row => [row.id, row.value]))),
  membershipsForChat: (chatId: string) => fromTable('membership', (rows) =>
    rows.filter((row) => row.chatId === chatId)),
  presence: (snapshot: ImRepositorySnapshot) => snapshot.presence,
  outbox: (snapshot: ImRepositorySnapshot) => snapshot.outbox
    .map((row) => row.value)
    .sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt)),
  view: (key: string) => (snapshot: ImRepositorySnapshot) => snapshot.view.find((row) => row.key === key)?.value,
  syncState: (key: string) => (snapshot: ImRepositorySnapshot) => snapshot.sync_state.find((row) => row.key === key)?.value,
}

// The account's repository once the chat provider has opened it, for readers that live outside the provider (read
// models). The provider still opens and closes it; this only hands out the one that is open.
type OpenedSlot = {
  promise: Promise<AccountImRepository>
  resolve: (repository: AccountImRepository) => void
  reject: (error: unknown) => void
  repository: AccountImRepository | null
  failed: boolean
}
const openedRepositories = new Map<string, OpenedSlot>()

function openedSlot(accountId: string): OpenedSlot {
  let slot = openedRepositories.get(accountId)
  if (!slot) {
    let resolve!: (repository: AccountImRepository) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<AccountImRepository>((done, fail) => { resolve = done; reject = fail })
    promise.catch(() => undefined) // a failed open is reported to whoever waits; nobody waiting is not an error
    slot = { promise, resolve, reject, repository: null, failed: false }
    openedRepositories.set(accountId, slot)
  }
  return slot
}

/** The account's repository if it is open now (for a first frame), else null: `openedImRepository` waits for it. */
export function openImRepositoryNow(accountId: string): AccountImRepository | null {
  return openedRepositories.get(accountId)?.repository ?? null
}

/** The account's open repository; waits while the provider is still opening it, and fails if that open failed. */
export function openedImRepository(accountId: string): Promise<AccountImRepository> {
  return openedSlot(accountId).promise
}

function publishOpened(repository: AccountImRepository): void {
  const previous = openedRepositories.get(repository.accountId)
  if (previous?.repository || previous?.failed) openedRepositories.delete(repository.accountId)
  const slot = openedSlot(repository.accountId)
  slot.repository = repository
  slot.resolve(repository)
}

export async function openImRepository(
  accountId: string,
  options: {
    adapter?: LocalImDbAdapter; storage?: Storage; initialize?: (repository: AccountImRepository) => Promise<void>
    /** Local rows are readable: the first frame. `initialize` (which may wait on the network) runs after it. */
    loaded?: (repository: AccountImRepository) => void
  } = {},
): Promise<AccountImRepository> {
  assertId(accountId, 'accountId')
  const startedAt = performance.now()
  const adapter = options.adapter ?? await openLocalSyncDb()
  try {
    const openedAt = performance.now()
    initializeMessages(accountId)
    if (!options.initialize) {
      if (options.storage !== undefined) await migrateLegacyChatList(adapter, accountId, options.storage)
      else if (typeof window !== 'undefined') await migrateLegacyChatList(adapter, accountId)
    }
    const preparedAt = performance.now()
    const rows = await adapter.loadAccount(accountId)
    // What a start spends on the local store before the first frame can draw: stage times and row counts, nothing else.
    repositoryLog.info({
      openMs: Math.round(openedAt - startedAt), prepareMs: Math.round(preparedAt - openedAt), loadMs: Math.round(performance.now() - preparedAt),
      chats: rows.chat.length, identities: rows.identity.length, memberships: rows.membership.length,
    }, 'local account rows read')
    const repository = createAccountRepository(accountId, adapter, rows, options.adapter === undefined)
    options.loaded?.(repository)
    await options.initialize?.(repository)
    publishOpened(repository)
    return repository
  } catch (error) {
    if (options.adapter === undefined) adapter.close()
    // Readers waiting for this account's repository learn that it did not open (a later open replaces this answer).
    const slot = openedSlot(accountId)
    if (!slot.repository) { slot.failed = true; slot.reject(error) }
    throw error
  }
}

function createAccountRepository(
  accountId: string,
  adapter: LocalImDbAdapter,
  initial: Record<ImStoreName, LocalImRow[]>,
  ownsAdapter: boolean,
): AccountImRepository {
  for (const store of IM_STORE_NAMES) {
    if (initial[store].some(row => row.accountId !== accountId)) throw new Error(`snapshot ${store} crossed account boundary`)
  }
  let current = freezeSnapshot(initial)
  let closed = false
  let writeChain = Promise.resolve()
  type Subscription = { selector: Selector<unknown>; listener: Listener<unknown>; selected?: { value: unknown } }
  const subscriptions = new Set<Subscription>()

  const ensureOpen = () => {
    if (closed) throw new Error(`IM repository scope ${accountId} is closed`)
  }
  // @@@selected-change — a subscriber hears about a commit only when what it selected changed (Object.is), not on every write
  // to any table: a React setter fed the same identities map on every message write parks each call on the hook's queue
  // until the provider renders again, and every call republished the identity directory.
  const notify = (subscription: Subscription) => {
    try {
      const value = subscription.selector(current)
      if (subscription.selected && Object.is(subscription.selected.value, value)) return
      subscription.selected = { value }
      subscription.listener(value, current)
    } catch (error) {
      repositoryLog.error({ error }, 'subscriber failed')
    }
  }
  const publish = () => { for (const subscription of subscriptions) notify(subscription) }

  const repository: AccountImRepository = {
    accountId,
    snapshot() {
      ensureOpen()
      return current
    },
    transaction(mutate) {
      ensureOpen()
      const run = writeChain.then(async () => {
        recordImTransaction()
        const operations: LocalImDbOperation[] = []
        const transaction = createTransaction(accountId, operations, current)
        const result = await mutate(transaction)
        validateOperations(accountId, operations)
        const applied = applyOperations(current, operations)
        await adapter.commit(applied.operations)
        current = applied.snapshot
        publish()
        return result
      })
      writeChain = run.then(() => undefined, () => undefined)
      return run
    },
    putIdentities(rows) {
      return this.transaction((transaction) => { for (const row of rows) transaction.putIdentity(row) })
    },
    subscribe<T>(selector: Selector<T>, listener: Listener<T>) {
      ensureOpen()
      const subscription: Subscription = { selector: selector as Selector<unknown>, listener: listener as Listener<unknown> }
      subscriptions.add(subscription)
      notify(subscription)
      return () => { subscriptions.delete(subscription) }
    },
    reset() {
      ensureOpen()
      const run = writeChain.then(async () => {
        await adapter.commit([{ type: 'clearAccount', accountId }])
        current = emptySnapshot()
        publish()
      })
      writeChain = run.then(() => undefined, () => undefined)
      return run
    },
    close() {
      if (closed) return
      closed = true
      subscriptions.clear()
      if (openedRepositories.get(accountId)?.repository === repository) openedRepositories.delete(accountId)
      if (ownsAdapter) void writeChain.finally(() => adapter.close())
    },
  }
  return repository
}

function createTransaction(accountId: string, operations: LocalImDbOperation[], stored: ImRepositorySnapshot): ImRepositoryTransaction {
  const put = (store: ImStoreName, value: LocalImRow) => operations.push({ type: 'put', store, value })
  const readView = (key: string): unknown => {
    for (let index = operations.length - 1; index >= 0; index -= 1) {
      const operation = operations[index]!
      if (operation.type === 'clearAccount') return undefined
      if (operation.type === 'put' && operation.store === 'view' && operation.value.key === key) return operation.value.value
      if (operation.type === 'delete' && operation.store === 'view' && Array.isArray(operation.key) && operation.key[1] === key) return undefined
    }
    return imSelectors.view(key)(stored)
  }
  const removed = new Set<string>()
  const identityWrites = new Set<string>()
  let cleared = false
  return {
    clear: () => {
      cleared = true
      operations.push({ type: 'clearAccount', accountId })
      // @@@legacy-chat-outbox — a rebuild replaces the cache; sends an older build queued here are not cache, they wait for the outbox to take them.
      for (const row of stored.outbox) put('outbox', row)
    },
    putIdentity: (value) => {
      const id = value && typeof value === 'object' && 'id' in value ? value.id : undefined
      const previous = typeof id === 'string' ? imSelectors.identitiesById(stored)[id] : undefined
      if (previous && !cleared && !identityWrites.has(previous.id) && replaceEqualDeep(previous, value) === previous) return
      // An identity the projection already parsed is kept as that object (parsing it again only makes an equal
      // copy, see @@@one-row-object); a raw row becomes its parsed form.
      const parsed = displayIdentityFromRow(value)
      const identity = replaceEqualDeep(value, parsed) === value ? value as DisplayIdentity : parsed
      // Removal is terminal on the server (a removed identity is immutable), so a row without
      // removed_at is an older observation and cannot bring a removed identity back.
      if (!identity.removed_at && (previous?.removed_at || removed.has(identity.id))) return
      if (identity.removed_at) removed.add(identity.id)
      identityWrites.add(identity.id)
      put('identity', { accountId, id: identity.id, value: identity })
    },
    putChat: (id, value) => put('chat', { accountId, id: nonEmpty(id, 'chat.id'), value }),
    putMembership: (chatId, identityId, value) => put('membership', {
      accountId,
      chatId: nonEmpty(chatId, 'membership.chatId'),
      identityId: nonEmpty(identityId, 'membership.identityId'),
      value,
    }),
    readView,
    putPresence: (identityId, value) => put('presence', {
      accountId,
      identityId: nonEmpty(identityId, 'presence.identityId'),
      value,
    }),
    putView: (key, value) => put('view', { accountId, key: nonEmpty(key, 'view.key'), value }),
    putSyncState: (key, value) => put('sync_state', { accountId, key: nonEmpty(key, 'sync_state.key'), value }),
    delete: (store, key) => {
      if (store === 'identity' && Array.isArray(key) && typeof key[1] === 'string') identityWrites.add(key[1])
      operations.push({ type: 'delete', store, key })
    },
  }
}

export async function replaceChatRows(repository: AccountImRepository, chats: readonly ChatItem[]): Promise<void> {
  await repository.transaction((transaction) => {
    writeChatRows(repository, transaction, chats)
  })
}

// @@@one-row-object: the stored (durable-shaped) row → the list row it was written from. A list row that is still the
// object the stored row came from has not changed, so it is not written again (no copy, no JSON comparison) —
// the conversation list is handed over on every update, and only the rows that changed cost anything.
const storedFrom = new WeakMap<object, ChatItem>()

export function writeChatRows(repository: AccountImRepository, transaction: ImRepositoryTransaction, chats: readonly ChatItem[]): void {
  writeChatRowChanges(repository, transaction, diffChatRows(imSelectors.chatRowsById(repository.snapshot()), chats))
}

/** Reference comparisons only; parsing and durable copies belong to the changed rows. */
function diffChatRows(current: ReadonlyMap<string, ChatItem>, next: readonly ChatItem[]): ChatRowChanges {
  const ids = new Set<string>()
  const changed: ChatItem[] = []
  for (const row of next) {
    ids.add(row.id)
    const stored = current.get(row.id)
    if (stored !== row && (!stored || storedFrom.get(stored) !== row)) changed.push(row)
  }
  return { changed, deleted: [...current.keys()].filter(id => !ids.has(id)) }
}

function writeChatRowChanges(repository: AccountImRepository, transaction: ImRepositoryTransaction, changes: ChatRowChanges): void {
  for (const id of changes.deleted) transaction.delete('chat', [repository.accountId, id])
  for (const chat of changes.changed) {
    const { read_state_version: _discarded, ...projection } = chat
    storedFrom.set(projection, chat)
    transaction.putChat(chat.id, projection as ChatItem)
  }
}

/**
 * The identities the stored account state still names: the account, the peers and members of the listed
 * conversations, their roster seats, the senders and addressees of their cached messages, and any the caller adds
 * (contacts). An identity outside this set is a leftover of a conversation that left the list.
 */
export function referencedIdentityIds(repository: AccountImRepository, also: Iterable<string>): Set<string> {
  const snapshot = repository.snapshot()
  const listed = new Set(snapshot.chat.map(row => row.id))
  const ids = new Set<string>([repository.accountId, ...also])
  for (const { value } of snapshot.chat) {
    if (value.peer_user_id) ids.add(value.peer_user_id)
    for (const id of value.member_user_ids ?? []) ids.add(id)
  }
  for (const row of snapshot.membership) if (listed.has(row.chatId)) ids.add(row.identityId)
  // Cached messages are the message store's windows (every platform), published per listed conversation.
  for (const chatId of listed) for (const value of messageWindow(repository.accountId, chatId) ?? []) {
    if (value.sender_user_id) ids.add(value.sender_user_id)
    for (const id of value.to_user_ids ?? []) ids.add(id)
  }
  return ids
}

/** Drop the cached identities nothing names any more, so a reconnect re-reads only live ones. Returns how many left. */
export async function pruneUnreferencedIdentities(repository: AccountImRepository, keep: ReadonlySet<string>): Promise<number> {
  const stale = repository.snapshot().identity.filter(row => !keep.has(row.id))
  if (stale.length) await repository.transaction((transaction) => {
    for (const row of stale) transaction.delete('identity', [repository.accountId, row.id])
  })
  return stale.length
}

/** Publish the conversation list with the identities it needs as one snapshot. */
export async function replaceChatRowsAndIdentities(
  repository: AccountImRepository,
  chats: readonly ChatItem[] | (() => readonly ChatItem[]),
  identities: readonly unknown[],
  isConversationDeleted?: (id: string) => boolean,
): Promise<void> {
  await repository.transaction((transaction) => {
    // Evaluate inside the serialized write: an older queued snapshot cannot undo a confirmed deletion.
    const changes = diffChatRows(imSelectors.chatRowsById(repository.snapshot()),
      (typeof chats === 'function' ? chats() : chats).filter(chat => !isConversationDeleted?.(chat.id)))
    for (const chat of changes.changed) {
      assertIdentityClosure('conversation list', chat.member_user_ids ?? [], identities)
      if (chat.peer_user_id) assertIdentityClosure('conversation list', [chat.peer_user_id], identities)
    }
    writeChatRowChanges(repository, transaction, changes)
    for (const identity of identities) transaction.putIdentity(identity)
  })
}

export function readChatRows(repository: AccountImRepository): ChatItem[] {
  return imSelectors.chats(repository.snapshot())
}

/** Publish a group roster with the identities it needs as one snapshot. */
export async function replaceGroupRoster(
  repository: AccountImRepository,
  chatId: string,
  snapshot: GroupCollabSnapshot,
  identities: readonly unknown[],
): Promise<void> {
  const members = [...snapshot.humans, ...snapshot.agents]
  // 名册里的每个成员都必须带身份;被删除的 agent(account_status 'removed')是墓碑,按定义没有身份行,读侧会剪掉。
  assertIdentityClosure(`group roster ${chatId}`, members.filter((member) => member.account_status !== 'removed').map((member) => member.id), identities)
  await repository.transaction((transaction) => {
    for (const row of repository.snapshot().membership) {
      if (row.chatId === chatId) transaction.delete('membership', [repository.accountId, chatId, row.identityId])
    }
    for (const member of members) {
      transaction.putMembership(chatId, member.id, {
        role: member.role,
        type: member.type,
        account_status: member.account_status,
        listen_mode: member.type === 'agent' ? (member as GroupAgentItem).listen_mode : null,
      })
    }
    // 成员行和它们的身份写在同一个事务里 —— 与 replaceChatRowsAndIdentities 同构。分开写就会有一段
    // 「行已落库、身份还没有」的窗口,而那段窗口正是下游拿空名字当 @ 匹配 key 的时机。
    for (const identity of identities) transaction.putIdentity(identity)
  })
}

/**
 * 名册里「身份缺席的活跃成员」不进本地库:getGroupCollab 对 identity.users 缺行的成员是**有意保留**的(记
 * [resolve-fail #1624] 日志、类型按 human),内存名册照显、本地持久化却会被 replaceGroupRoster 的闭包断言整份
 * 拒掉 —— 那条断言是给「调用方忘了交身份」的 tripwire,不该由它来替上游的数据缺口做决定。所以由调用方在这里
 * **明确地**剪掉这些成员再写:剪掉了谁在日志里可查,与冷启动投影(assemble 只带有身份的成员)是同一条规则。
 * 被删除的 agent(account_status 'removed')是墓碑、按定义没有身份行,原样保留。
 */
export function persistableGroupRoster(chatId: string, snapshot: GroupCollabSnapshot, identities: readonly unknown[]): GroupCollabSnapshot {
  const present = new Set<string>()
  for (const identity of identities) {
    const id = (identity as { id?: unknown } | null)?.id
    if (typeof id === 'string') present.add(id)
  }
  const keep = (member: GroupMemberItem | GroupAgentItem) => present.has(member.id) || member.account_status === 'removed'
  const dropped = [...snapshot.humans, ...snapshot.agents].filter((member) => !keep(member)).map((member) => member.id)
  if (dropped.length === 0) return snapshot
  repositoryLog.warn({ chatId, dropped }, 'group roster members without identity are not persisted locally')
  return { ...snapshot, humans: snapshot.humans.filter(keep), agents: snapshot.agents.filter(keep) }
}

export function readGroupRoster(repository: AccountImRepository, chatId: string): GroupCollabSnapshot | null {
  const snapshot = repository.snapshot()
  const memberships = snapshot.membership.filter((row) => row.chatId === chatId)
  if (memberships.length === 0) return null
  const humans: GroupMemberItem[] = []
  const agents: GroupAgentItem[] = []
  for (const membership of memberships) {
    const member = membership.value
    const base: GroupMemberItem = {
      id: membership.identityId,
      role: member.role as GroupMemberItem['role'],
      type: member.type as GroupMemberItem['type'],
      account_status: member.account_status as GroupMemberItem['account_status'],
    }
    if (base.type === 'agent') {
      agents.push({
        ...base,
        type: 'agent',
        client: null,
        model_source: null,
        tools: [],
        permission_scope: null,
        current_task_id: null,
        current_task_title: null,
        last_action: null,
        last_active_at: null,
        // @@@5856 ❗ 不走裸 cast:本机缓存里还躺着升级前写的 'adaptive'。裸 cast 会让它成为
        // 一个被当成 ListenMode 用的非法值 ⇒ 成员面板 SWR 首帧的档位开关读错这些 agent,
        // 直到权威快照合并回来。跟 resolveListenModeDefault 用同一把尺。
        listen_mode: resolveListenModeDefault(typeof member.listen_mode === 'string' ? member.listen_mode : null),
      })
    } else humans.push(base)
  }
  return { scheduler: emptyScheduler(chatId), humans, agents, tasks: [] }
}

/** The place a new row keeps in its conversation until it is confirmed (stored with its outbox write). */
export function outboxMessagePosition(repository: AccountImRepository, record: OutboxRecord): OutboxRecord {
  if (record.preview?.local_timeline) return record
  const root = record.payload.threadRootId ?? null
  const rows = messageWindow(repository.accountId, record.chatId, root) ?? []
  return { ...record, preview: { ...record.preview, local_timeline: captureMessagePosition(rows, record.enqueuedAt) } }
}

/** A confirmed send: the authoritative message, written where messages are read. */
export async function confirmSentMessage(repository: AccountImRepository, record: OutboxRecord, message: MessageItem): Promise<MessageItem> {
  if (message.id !== record.clientMessageId) throw new Error(`outbox ack id mismatch: ${record.clientMessageId} != ${message.id}`)
  await ingestMessages(repository.accountId, { writes: [{ type: 'put', message }], revisions: [] })
  return message
}

/**
 * @@@legacy-chat-outbox — chat sends an older build queued in this cache: each handed to `take` (the outbox), then removed
 * here; one whose source was discarded goes with it. Delete with the `outbox` store once no build that writes it is in use.
 */
export async function takeLegacyOutboxRecords(repository: AccountImRepository, take: (record: OutboxRecord) => Promise<void>): Promise<void> {
  const rows = imSelectors.outbox(repository.snapshot()).filter((row) => row.senderUserId === repository.accountId)
  for (const row of rows) if (!row.dependencyDiscarded) await take(row)
  if (rows.length) await repository.transaction((transaction) => { for (const row of rows) transaction.delete('outbox', [repository.accountId, row.clientMessageId]) })
}

function emptyScheduler(chatId: string): GroupSchedulerState {
  return {
    chat_id: chatId,
    paused: false,
    queue_count: 0,
    blocked_count: 0,
    summary: null,
    updated_at: new Date(0).toISOString(),
  }
}

function validateOperations(accountId: string, operations: readonly LocalImDbOperation[]): void {
  for (const operation of operations) {
    if (operation.type === 'put' && operation.value.accountId !== accountId) {
      throw new Error(`repository transaction crossed account boundary: ${operation.value.accountId} != ${accountId}`)
    }
    if (operation.type === 'clearAccount' && operation.accountId !== accountId) {
      throw new Error(`repository reset crossed account boundary: ${operation.accountId} != ${accountId}`)
    }
    if (operation.type === 'delete') {
      const keyAccount = Array.isArray(operation.key) ? operation.key[0] : null
      if (keyAccount !== accountId) {
        throw new Error(`repository delete crossed account boundary: ${String(keyAccount)} != ${accountId}`)
      }
    }
  }
}

function applyOperations(
  snapshot: ImRepositorySnapshot,
  operations: readonly LocalImDbOperation[],
): { snapshot: ImRepositorySnapshot; operations: LocalImDbOperation[] } {
  // 每张碰到的表按主键建一次索引,一次事务里的写都落在它上面。真改了的表才换成新数组;没碰到、或只是把一行原样再写
  // 一遍的表(每次刷会话列表都会把全部身份再写一遍)还是原来那个对象 —— @@@table-selector 靠它认出「没变」。
  // 从前每写一行都按 JSON 比一遍整张表,身份表每刷一次就是 行数² 次序列化。
  const next = { ...snapshot } as unknown as MutableSnapshot
  const edits = new Map<ImStoreName, Map<string, LocalImRow>>()
  const changed = new Set<ImStoreName>()
  const effective: LocalImDbOperation[] = []
  const rowsOf = (store: ImStoreName) => {
    let rows = edits.get(store)
    if (!rows) {
      rows = new Map(tableIndex(store, next[store]))
      edits.set(store, rows)
    }
    return rows
  }
  for (const operation of operations) {
    if (operation.type === 'clearAccount') {
      for (const store of IM_STORE_NAMES) {
        edits.set(store, new Map())
        changed.add(store)
      }
      effective.push(operation)
      continue
    }
    const rows = rowsOf(operation.store)
    const key = JSON.stringify(operation.type === 'put' ? keyForRow(operation.store, operation.value) : operation.key)
    if (operation.type === 'put') {
      const existing = rows.get(key)
      if (existing && JSON.stringify(existing) === JSON.stringify(operation.value)) {
        if (operation.store === 'chat') {
          const source = storedFrom.get(operation.value.value as object)
          if (source) storedFrom.set(existing.value as object, source)
        }
        continue
      }
      // @@@one-row-object: the snapshot holds the value it was handed (frozen below), not a clone of it — an identity
      // the projection read is then one object in both. Writers hand over values they no longer change.
      rows.set(key, operation.value)
      changed.add(operation.store)
      effective.push(operation)
    } else if (rows.delete(key)) {
      changed.add(operation.store)
      effective.push(operation)
    }
  }
  for (const store of changed) {
    next[store] = [...edits.get(store)!.values()]
    tableIndexes.set(next[store], edits.get(store)!)
  }
  // Prepare with the existing row comparison before persistence; publish only after this batch commits.
  return { snapshot: freezeSnapshot(next), operations: effective }
}

// A table's rows by key, built once per table array: a transaction copies it (pointers) instead of re-keying every
// row with JSON.stringify — the cost of a write no longer grows with the table.
const tableIndexes = new WeakMap<readonly LocalImRow[], Map<string, LocalImRow>>()
function tableIndex(store: ImStoreName, rows: readonly LocalImRow[]): Map<string, LocalImRow> {
  let index = tableIndexes.get(rows)
  if (!index) tableIndexes.set(rows, index = new Map(rows.map((row) => [JSON.stringify(keyForRow(store, row)), row])))
  return index
}

function keyForRow(store: ImStoreName, row: LocalImRow): IDBValidKey {
  const value = row as Record<string, unknown>
  if (store === 'membership') return [value.accountId as string, value.chatId as string, value.identityId as string]
  if (store === 'presence') return [value.accountId as string, value.identityId as string]
  if (store === 'view' || store === 'sync_state') return [value.accountId as string, value.key as string]
  return [value.accountId as string, value.id as string]
}

function freezeSnapshot(rows: Record<ImStoreName, LocalImRow[]>): ImRepositorySnapshot {
  return deepFreeze(Object.fromEntries(IM_STORE_NAMES.map((store) => [store, rows[store]]))) as unknown as ImRepositorySnapshot
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  // 冻过的就是这里整棵冻过的(上一份快照留下的表与行):不再走一遍。
  if (typeof value !== 'object' || value === null || seen.has(value) || Object.isFrozen(value)) return value
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key], seen)
  return Object.freeze(value)
}

function emptySnapshot(): ImRepositorySnapshot {
  return freezeSnapshot(Object.fromEntries(IM_STORE_NAMES.map((store) => [store, []])) as unknown as Record<ImStoreName, LocalImRow[]>)
}

function nonEmpty(value: string, label: string): string {
  if (!value) throw new Error(`${label} must be a non-empty string`)
  return value
}

function assertId(value: string, label: string): void {
  nonEmpty(value, label)
}
