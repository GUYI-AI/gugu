// @vitest-environment jsdom
// Network and OS boundaries are controlled; publication, revision dispatch and
// the account message repository use the production implementations.
import { act, useCallback, useLayoutEffect, useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chat, createReactHarness, deferred, displayIdentity } from '../../../support/testHarness'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { openImRepository, type AccountImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { messageWindow } from '../../../../apps/desktop/src/lib/messageWindows'
import { createAccountRevisionCoordinator, type AccountRevisionCoordinator } from '../../../../apps/desktop/src/lib/accountRevisionCoordinator'
import type { AccountRevisionSource, AccountRevisionOperation } from '../../../../apps/desktop/src/lib/accountRevisionRuntime'
import { createChatListProjectionLedger, useChatProjectionBinding } from '../../../../apps/desktop/src/store/chatListProjection'
import * as notifications from '../../../../apps/desktop/src/store/chatListProjection'
import { unknownMemberName } from '../../../../apps/desktop/src/lib/memberFallbackName'
import enMessaging from '../../../../apps/desktop/src/i18n/locales/en-US/messaging'
import zhMessaging from '../../../../apps/desktop/src/i18n/locales/zh-CN/messaging'

const native = vi.hoisted(() => ({
  show: vi.fn(),
  capabilities: { notifications: true, conversationNotifications: true as boolean },
  faces: undefined as undefined | (() => unknown),
  current: true,
}))
vi.mock('../../../../apps/desktop/src/platform', () => ({
  platform: { capabilities: native.capabilities, showNotification: native.show },
}))
vi.mock('../../../../apps/desktop/src/lib/onScreenChat', () => ({ isChatOnScreen: () => false }))
// The faces module draws on a canvas; here every face is simply not known, so the presentation is deterministic.
vi.mock('../../../../apps/desktop/src/lib/chatNotificationFaces', () => ({
  createNotificationFaceSources: () => native.faces!(),
}))
const noFaces = () => ({ identity: async () => null, userFace: async () => null, groupFace: async () => null })
/** The banner is presented after its (async) presentation settles; the coordinator does not wait for it. */
const delivered = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })

type Response = { data: unknown; error: null }
const cloudRows = new Map<string, unknown[]>()
function builder(key: string): unknown {
  const chain: unknown = new Proxy(function noop() {} as unknown as object, {
    get(_target, property) {
      if (property === 'then') return (resolve: (value: Response) => unknown, reject?: (reason: unknown) => unknown) => {
        return Promise.resolve({ data: cloudRows.get(key) ?? [], error: null }).then(resolve, reject)
      }
      return () => chain
    },
    apply: () => chain,
  })
  return chain
}
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  chatDb: { from: (table: string) => builder(table), rpc: (fn: string) => builder(`rpc:${fn}`) },
  identityDb: { from: (table: string) => builder(table), rpc: (fn: string) => builder(`rpc:${fn}`) },
}))
vi.mock('../../../../apps/desktop/src/lib/identityReadAdapter', () => ({
  readDisplayIdentities: async (ids: readonly string[]) => ids.map(id => displayIdentity(id)),
}))

const ACCOUNT = 'notify-viewer'
const GROUP = 'notify-group'
const MESSAGE = 'notify-message-1'
const AT = '2026-01-01T00:00:00.000Z'
const noUnread = () => chat({ id: GROUP, kind: 'group', name: 'Fixture group', member_user_ids: [ACCOUNT] })
const locator = { chat_id: GROUP, stream_id: `main:${GROUP}`, stream_kind: 'main' as const, thread_root_id: null,
  message_id: MESSAGE, message_seq: 1, unread_count: 1, addressed_count: 1, cursor_seq: 0, version: 1, is_marked_unread: false }
const nextRow = (): ChatItem => ({ ...noUnread(), next_message_seq: 2, last_message_at: AT,
  last_message_preview: 'controlled addressed message', unread_count: 1, unread_locator: locator })
const messageRow = { id: MESSAGE, chat_id: GROUP, seq: 1, content: 'controlled addressed message', preview: 'controlled addressed message',
  content_type: 'text', sender_user_id: 'notify-sender', to_user_ids: [ACCOUNT], created_at: AT,
  thread_root_id: null, is_thread_root: false, is_whisper: false, client_message_id: null, deleted_at: null }

let repository: AccountImRepository
let harness: ReturnType<typeof createReactHarness>
let binding: ReturnType<typeof useChatProjectionBinding>
let releaseCommit: ReturnType<typeof deferred<void>>
let holdCommit = false
let coordinator: AccountRevisionCoordinator | null = null
let enabled = true
let wake: (head: string) => void
const pending: AccountRevisionOperation[] = []
const bodyPresentAtNotification: boolean[] = []

function Owner({ notificationsEnabled = true }: { notificationsEnabled?: boolean }) {
  enabled = notificationsEnabled
  const [rows, setRows] = useState<ChatItem[]>([noUnread()])
  const chatsRef = useRef(rows)
  useLayoutEffect(() => { chatsRef.current = rows }, [rows])
  const ledger = useRef(createChatListProjectionLedger())
  const repositoryRef = useRef<AccountImRepository | null>(repository)
  const activeChatIdRef = useRef<string | null>(null)
  const requestSeqRef = useRef(0)
  const getRepository = useCallback(async () => repository, [])
  const onActiveRevoked = useCallback(() => undefined, [])
  const canAcknowledge = useCallback(() => false, [])
  const visibleSeqOf = useCallback(() => 0, [])
  binding = useChatProjectionBinding({ ledger: ledger.current, conversations: { readSeqsOf: () => undefined }, repositoryRef, getRepository, chatsRef,
    activeChatIdRef, requestSeqRef, setChats: setRows, onActiveRevoked, canAcknowledge, visibleSeqOf,
    notifications: { chatMessages: notificationsEnabled, sound: false } })
  return null
}

beforeEach(async () => {
  bodyPresentAtNotification.length = 0
  cloudRows.clear()
  pending.length = 0
  holdCommit = false; releaseCommit = deferred<void>(); coordinator = null
  const memory = createMemoryLocalSyncDb()
  repository = await openImRepository(ACCOUNT, { adapter: { ...memory, commit: async (operations) => {
    if (holdCommit) await releaseCommit.promise
    return memory.commit(operations)
  } } })
  await repository.transaction(tx => tx.putSyncState('account-revision-cursor', { revision: '0' }))
  native.capabilities.conversationNotifications = true; native.faces = noFaces; native.current = true
  native.show.mockReset().mockImplementation(async () => {
    bodyPresentAtNotification.push((messageWindow(ACCOUNT, GROUP) ?? []).some(row => row.id === MESSAGE))
    return { success: true, displayed: false }
  })
  cloudRows.set('rpc:list_conversation_memberships', [{ chat_id: GROUP, user_id: ACCOUNT, last_read_seq: 0, is_marked_unread: false,
    version: 1, notification_level: 'all', is_pinned: false, role: 'member', updated_at: AT, joined_at: AT, inbox_published_at: AT }])
  cloudRows.set('active_members', cloudRows.get('rpc:list_conversation_memberships')!)
  cloudRows.set('chats', [{ id: GROUP, public_id: null, kind: 'group', status: 'active', name: 'Fixture group', avatar_url: null,
    created_at: AT, last_message_at: null, last_message_preview: null, next_message_seq: 1, pinned_message_id: null }])
  cloudRows.set('messages_view', []); cloudRows.set('rpc:list_unread_locators', []); cloudRows.set('contact_overrides', [])
  harness = createReactHarness()
  await harness.render(<Owner />)
  await act(async () => { await binding.publish([noUnread()], [displayIdentity(ACCOUNT)], { requestSeq: 0, notify: false }) })
  const source: AccountRevisionSource = {
    syncSince: async cursor => ({ operations: pending.filter(operation => BigInt(operation.revision) > BigInt(cursor)), hasMore: false }),
    subscribeWake: (_account, onWake) => { wake = onWake; return () => undefined },
  }
  coordinator = createAccountRevisionCoordinator(ACCOUNT, repository, source, {
    recover: async () => { throw new Error('complete message fixture must not need recovery') },
    notify: async message => notifications.notifyForIngestedMessage(ACCOUNT,
      repository.snapshot().chat.find(row => row.id === GROUP)!.value, message,
      { onScreen: () => false, notificationsEnabled: enabled, soundEnabled: false, isCurrent: () => native.current }),
  })
  coordinator.start()
  await coordinator.whenIdle() // Initial catchup is a silent baseline, not a live arrival.
})

afterEach(() => {
  releaseCommit.resolve()
  coordinator?.stop()
  harness.cleanup()
  repository.close()
})

describe('chat notification ingestion', () => {
  const publish = async (row = nextRow(), requestSeq = 1, sender: { sender_user_id?: string | null } = {}) => {
    await act(async () => {
      const id = row.unread_locator?.message_id ?? MESSAGE
      pending.push({ revision: String(pending.length + 1), event: 'message_created', payload: {
        chat_id: GROUP, entity_id: id, message: { ...messageRow, ...sender, id, seq: row.unread_locator?.message_seq ?? 1 },
      } })
      wake(String(pending.length))
      await coordinator!.whenIdle()
      await binding.publish([row], [displayIdentity(ACCOUNT)], { requestSeq, notify: true })
    })
    await delivered()
  }

  it('notifies once for one eligible off-screen publication', async () => {
    await publish()
    expect(native.show).toHaveBeenCalledExactlyOnceWith({
      title: 'Fixture group', body: 'controlled addressed message', chatId: GROUP, silent: true,
      // No identity directory in this window: the group is named by what the chat row knows and its author, not being
      // known, by the chat's own unknown-member label; no picture, and the notification still goes out at once.
      presentation: {
        accountId: ACCOUNT, messageId: MESSAGE, sentAt: Date.parse(AT),
        conversation: { id: GROUP, kind: 'group', name: 'Fixture group', avatar: null },
        author: { id: 'notify-sender', name: unknownMemberName(), avatar: null },
      },
    })
  })

  it('names the author of a deleted account with the label the chat shows for a member it cannot name, not the group', async () => {
    native.faces = () => ({ identity: async (id: string) => displayIdentity(id), groupFace: async () => null, userFace: async () => null })
    await publish(nextRow(), 1, { sender_user_id: null })
    const { author, conversation } = native.show.mock.calls[0]![0].presentation
    expect(author).toEqual({ id: null, name: unknownMemberName(), avatar: null })
    // The catalog's own wording (whichever language this window runs in), not a made-up one.
    expect([zhMessaging.group.memberFallback.unknown, enMessaging.group.memberFallback.unknown]).toContain(author.name)
    expect(author.name).not.toBe(conversation.name)
  })

  it('does not notify again when the same message is replayed after publication settles', async () => {
    await publish()
    await publish(nextRow(), 2)
    expect(native.show).toHaveBeenCalledTimes(1)
  })

  it('still notifies for a different addressed message', async () => {
    await publish()
    await publish({ ...nextRow(), next_message_seq: 3, unread_count: 2,
      unread_locator: { ...locator, message_id: 'notify-message-2', message_seq: 2,
        unread_count: 2, addressed_count: 2, version: 2 } }, 2)
    expect(native.show).toHaveBeenCalledTimes(2)
  })

  it('gives a host that does not draw conversations the notification exactly as before', async () => {
    native.capabilities.conversationNotifications = false
    await publish()
    expect(native.show).toHaveBeenCalledExactlyOnceWith({
      title: 'Fixture group', body: 'controlled addressed message', chatId: GROUP, silent: true,
    })
  })

  it('goes out after the picture budget without slow pictures, then refreshes the same message silently', async () => {
    let finish: (face: string) => void = () => undefined
    native.faces = () => ({ identity: async (id: string) => displayIdentity(id), groupFace: async () => null,
      userFace: () => new Promise<string>((resolve) => { finish = resolve }) })
    await publish()
    expect(native.show).not.toHaveBeenCalled() // still inside the picture budget
    // Past the budget the banner went out without the face; the face then arrives.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1300)) })
    expect(native.show.mock.calls[0]![0].presentation).toMatchObject({ author: { avatar: null }, conversation: { avatar: null } })
    await act(async () => { finish('late-face') })
    await vi.waitFor(() => expect(native.show).toHaveBeenCalledTimes(2), { timeout: 3000 })
    expect(native.show.mock.calls[1]![0]).toMatchObject({ chatId: GROUP, presentation: { messageId: MESSAGE, update: true, author: { avatar: 'late-face' } } })
  }, 10_000)

  it('drops a late picture refresh once the account is no longer current', async () => {
    let finish: (face: string) => void = () => undefined
    native.faces = () => ({ identity: async (id: string) => displayIdentity(id), groupFace: async () => null,
      userFace: () => new Promise<string>((resolve) => { finish = resolve }) })
    await publish()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1300)) })
    native.current = false
    await act(async () => { finish('late-face') })
    await delivered()
    expect(native.show).toHaveBeenCalledTimes(1)
  }, 10_000)

  it('still shows the banner as before when the presentation cannot be prepared', async () => {
    native.faces = () => { throw new Error('faces unavailable') }
    await publish()
    expect(native.show).toHaveBeenCalledExactlyOnceWith({
      title: 'Fixture group', body: 'controlled addressed message', chatId: GROUP, silent: true,
    })
  })

  it('does not notify when chat message notifications are disabled', async () => {
    await harness.render(<Owner notificationsEnabled={false} />)
    await publish()
    expect(native.show).not.toHaveBeenCalled()
  })

  it('emits one notification for one message when publications overlap before commit', async () => {
    // Actual shared publish boundary used by hydration/refresh and revision attachment;
    // this does not claim three independent network deliveries were reproduced.
    holdCommit = true
    await act(async () => {
      const publications = [1, 2, 3].map(requestSeq => publish(nextRow(), requestSeq))
      releaseCommit.resolve()
      await Promise.all(publications)
    })
    await delivered()
    expect(native.show).toHaveBeenCalledTimes(1)
  })

  it('stores the complete revision message before notifying for an unobserved chat', async () => {
    await act(async () => {
      const rows = await binding.hydrate(ACCOUNT)
      expect(rows.map(row => row.id)).toContain(GROUP)
      await binding.publish(rows, binding.identities(ACCOUNT), { requestSeq: 1, notify: false })
    })
    cloudRows.set('messages_view', [messageRow])
    cloudRows.set('rpc:list_unread_locators', [locator])
    const stop = binding.attach(ACCOUNT, coordinator!.subscribe)
    try {
      await act(async () => {
        pending.push({ revision: '1', event: 'message_created', payload: { chat_id: GROUP, entity_id: MESSAGE, message: messageRow } })
        wake('1'); await coordinator!.whenIdle()
      })
      await delivered()
      expect(native.show).toHaveBeenCalledTimes(1)
      expect(bodyPresentAtNotification).toEqual([true])
    } finally { stop() }
  })
})
