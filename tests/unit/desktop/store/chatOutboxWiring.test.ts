// @vitest-environment jsdom
import * as attachmentEndpoint from '../../../../apps/desktop/src/lib/attachmentsEndpoint'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { upsertMessageById } from '@gugu/core/shared/ui/messageListModels'
import { chatService } from '../../../../apps/desktop/src/lib/chat'
import { topicService } from '../../../../apps/desktop/src/lib/topics'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { openImRepository, type AccountImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { createOutbox, type Outbox, type OutboxItem } from '../../../../apps/desktop/src/lib/outbox/core'
import { recordOf, type ChatSend } from '../../../../apps/desktop/src/store/chatOutbox'
import { fakeAccount, memoryStorage } from './chatOutboxHarness'
import {
  bindOutboxActions,
  createOutboxWiring,
  resolveOutboxRecipients,
  type OutboxWiringIo,
} from '../../../../apps/desktop/src/store/chatOutboxWiring'
import type { OutboxRecord } from '../../../../apps/desktop/src/lib/imRepository'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n'
import { chat } from '../../../support/testHarness'
import { bindBackendProbe, noteBackendAnswer } from '../../../../packages/core/src/cloud/backendReachability'
const logError = vi.hoisted(() => vi.fn())
vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: logError }) }))
vi.mock('../../../../apps/desktop/src/lib/loading/LoadingIndicator', () => ({ LoadingIndicator: () => null }))
const notices = vi.hoisted(() => {
  const visible = new Map<string | number, string>()
  let sequence = 0
  const show = vi.fn((title: string, options?: { id?: string }) => {
    const id = options?.id ?? ++sequence
    visible.set(id, title)
    return id
  })
  return { visible, show, dismiss: vi.fn((id: string | number) => { visible.delete(id) }) }
})
vi.mock('sonner', () => ({ toast: Object.assign(notices.show, {
  success: notices.show, error: notices.show, warning: notices.show, info: notices.show, dismiss: notices.dismiss,
}) }))
import { notify } from '../../../../apps/desktop/src/lib/notices'
vi.mock('../../../../apps/desktop/src/lib/widgetLabels', () => ({ widgetReferenceTexts: async () => new Map() }))
// A delivered send advances the read marker, whose write would go to the network: it failed late, inside a later test,
// and the failed write's probe request counted as that test's pull (CI: called 2 times). No test here is about reads.
vi.mock('../../../../apps/desktop/src/lib/readWriter', async (original) => ({ ...(await original<object>()), writeRead: async () => {} }))

function persistedMessage(id: string): MessageItem {
  return {
    id,
    chat_id: 'chat-1',
    sender_user_id: 'owner-1',
    to_user_ids: null,
    is_whisper: false,
    seq: 42,
    content: 'hello',
    content_type: 'text',
    reply_to_message_id: null,
    thread_root_id: null,
    is_thread_root: false,
    retracted_at: null,
    created_at: '2026-07-27T00:00:00.000Z',
    reactions: [],
    is_mine: true,
    delivered: false,
    delivery_status: null,
    local_send_state: null,
  }
}

function optimisticMessage(id: string): MessageItem {
  return {
    ...persistedMessage(id),
    seq: -1,
    local_send_state: 'sending',
  }
}

function wiringHarness(messageId: string, overrides: Partial<OutboxWiringIo> = {}) {
  let messages = [optimisticMessage(messageId)]
  let threadMessages: MessageItem[] = []
  const toast = vi.fn<OutboxWiringIo['toast']>((title, tier) => { notify({ title, tier }) })
  const patchChat = vi.fn<OutboxWiringIo['patchChat']>()
  // @@@4439 — store 摄入 chokepoint 的替身:按 id 归并进主线(跳号重验证语义属 store 侧,
  // 由 chatMessageWindow 的 seqJumpRepairCursor 纯函数测试钉住)。
  const appendMessage = vi.fn<OutboxWiringIo['appendMessage']>((message) => {
    messages = upsertMessageById(messages, message)
  })
  const repository = openImRepository('owner-1', {
    adapter: createMemoryLocalSyncDb(),
    storage: window.localStorage,
  })
  const io: OutboxWiringIo = {
    getImRepository: () => repository,
    user: () => ({ id: 'owner-1', nickname: 'Owner', avatarUrl: null }),
    identity: () => undefined,
    chats: () => [],
    chatShown: (id) => id === 'chat-1',
    activeThreadRootId: () => null,
    setMessagesAndCache: (updater) => { messages = updater(messages) },
    setThreadMessages: (updater) => {
      threadMessages = typeof updater === 'function' ? updater(threadMessages) : updater
    },
    patchChat,
    toast,
    appendMessage,
    ...overrides,
  }
  return {
    repository,
    wiring: createOutboxWiring(io),
    messages: () => messages,
    patchChat,
    toast,
    appendMessage,
  }
}

function enqueueInput(id: string) {
  return {
    id,
    chatId: 'chat-1',
    senderUserId: 'owner-1',
    content: 'hello',
    toUserIds: ['agent-1'],
    replyToMessageId: null,
    threadRootId: null,
    isThreadRoot: false,
    isWhisper: false,
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve()
}

// The window's one outbox (lib/outbox `outbox()`), real, over memory, for the account the wiring sends as.
let box: Outbox
const outboxRows = () => (box.items() as OutboxItem<ChatSend>[]).map(recordOf)
beforeEach(() => {
  box = createOutbox({ storage: memoryStorage(), account: fakeAccount('owner-1'), online: () => () => {} })
  ;(globalThis as Record<string, unknown>).__GUGU_OUTBOX__ = box
})
afterEach(() => {
  box.dispose()
  delete (globalThis as Record<string, unknown>).__GUGU_OUTBOX__
  notices.visible.clear()
  setLocalePreference('zh-CN')
  logError.mockClear()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('message-owned send failure notices', () => {
  it.each(['direct-peer', 'group-agent'])('retires the exact offscreen failure after retry succeeds (%s)', async recipient => {
    vi.useFakeTimers()
    const row = persistedMessage(`retry-${recipient}`)
    const send = vi.spyOn(chatService, 'sendMessage').mockRejectedValue(new Error('offline'))
    const h = wiringHarness(row.id, { chatShown: () => false })
    await h.wiring.enqueue({ ...enqueueInput(row.id), toUserIds: [recipient] })
    await vi.advanceTimersByTimeAsync(25_000)
    expect(h.messages()[0]).toMatchObject({ id: row.id, local_send_state: 'failed' })
    expect(notices.visible.size).toBe(1)
    send.mockResolvedValue(row)
    h.wiring.retrySend(row.id)
    await vi.advanceTimersByTimeAsync(100)
    expect(h.messages()[0]).toMatchObject({ id: row.id, seq: 42, local_send_state: null })
    expect(notices.visible.size, 'the acknowledged message still has its old failure notice').toBe(0)
    h.wiring.dispose()
  })

  // #2565: a chat block on the task page shows its conversation without selecting it; the row is in front of the user.
  it('a failure in a conversation that is shown stays on its own row, with no notice to go back there', async () => {
    vi.useFakeTimers()
    vi.spyOn(chatService, 'sendMessage').mockRejectedValue(new Error('offline'))
    const h = wiringHarness('shown', { chatShown: (id) => id === 'chat-1' })
    await h.wiring.enqueue(enqueueInput('shown'))
    await vi.advanceTimersByTimeAsync(25_000)
    expect(h.messages()[0]).toMatchObject({ id: 'shown', local_send_state: 'failed' })
    expect(notices.visible.size).toBe(0)
    h.wiring.dispose()
  })

  it('a thread reply counts as shown only while its thread is open in the shown conversation', async () => {
    vi.useFakeTimers()
    vi.spyOn(chatService, 'sendMessage').mockRejectedValue(new Error('offline'))
    let openThread: string | null = 'root-other'
    const h = wiringHarness('reply', { chatShown: () => true, activeThreadRootId: (chatId) => chatId === 'chat-1' ? openThread : null })
    await h.wiring.enqueue({ ...enqueueInput('reply'), threadRootId: 'root-1' })
    await vi.advanceTimersByTimeAsync(25_000)
    expect(notices.visible.size, 'another thread is open: the failed reply is out of sight').toBe(1)
    openThread = 'root-1'
    await h.wiring.enqueue({ ...enqueueInput('reply-2'), threadRootId: 'root-1' })
    await vi.advanceTimersByTimeAsync(25_000)
    expect(notices.visible.size, 'its thread is open: the row says it').toBe(1)
    h.wiring.dispose()
  })

  it('updates a failed retry without duplicating the notice or clearing another message failure', async () => {
    vi.useFakeTimers()
    const send = vi.spyOn(chatService, 'sendMessage').mockRejectedValue(new Error('offline'))
    const h = wiringHarness('first', { chatShown: () => false })
    await h.wiring.enqueue(enqueueInput('first'))
    await h.wiring.enqueue(enqueueInput('second'))
    await vi.advanceTimersByTimeAsync(50_000)
    expect(notices.visible.size).toBe(2)
    h.wiring.retrySend('first')
    await vi.advanceTimersByTimeAsync(25_000)
    expect(notices.visible.size, 'the failed retry stacked another unowned notice').toBe(2)
    send.mockResolvedValue(persistedMessage('first'))
    h.wiring.retrySend('first')
    await vi.advanceTimersByTimeAsync(100)
    expect(notices.visible.size, 'success must retire only the matching message').toBe(1)
    h.wiring.dispose()
  })
})

it('queues the source and explicit recipients through the existing topic service', async () => {
  const sourceMessageId = 'topic-source'
  const created = { chat_id: 'created-topic', public_id: null, name: 'Source contract',
    source_chat_id: 'chat-1', source_message_id: sourceMessageId, creator_user_id: 'owner-1' }
  const create = vi.spyOn(topicService, 'createTopic').mockResolvedValue(created)
  const send = vi.spyOn(chatService, 'sendMessage').mockRejectedValue(new Error('Topics must use create_topic'))
  const f = wiringHarness(sourceMessageId)
  try {
    const actions = bindOutboxActions({ current: f.wiring }, 'owner-1')
    expect(await actions.createTopic({ sourceChatId: 'chat-1', sourceMessageId, name: 'Source contract', memberUserIds: ['explicit-peer'] }))
      .toEqual(created)
    expect(create).toHaveBeenCalledExactlyOnceWith({ sourceChatId: 'chat-1', sourceMessageId,
      name: 'Source contract', memberUserIds: ['explicit-peer'], topicId: expect.any(String) })
    expect(send).not.toHaveBeenCalled()
    expect(box.items().filter((item) => item.kind === 'chatMessage')).toEqual([]) // the read position a send advances is its own write
  } finally {
    f.wiring.dispose()
    const repository = await f.repository
    repository.close()
  }
})

describe('committed outbound reconciliation', () => {
  it('stale restoreAndWatch after dispose never reacquires the repository', async () => {
    const getImRepository = vi.fn(async () => openImRepository('owner-1', {
      adapter: createMemoryLocalSyncDb(), storage: window.localStorage,
    }))
    const io: OutboxWiringIo = {
      getImRepository,
      user: () => ({ id: 'owner-1', nickname: 'Owner', avatarUrl: null }),
      identity: () => undefined,
      chats: () => [], chatShown: () => false, activeThreadRootId: () => null,
      setMessagesAndCache: () => {}, setThreadMessages: () => {}, patchChat: () => {},
      toast: () => {},
      appendMessage: () => {},
    }
    const wiring = createOutboxWiring(io)

    wiring.dispose()
    const stop = wiring.restoreAndWatch()
    await flushMicrotasks()
    stop()

    expect(getImRepository).not.toHaveBeenCalled()
  })

  it('rejects if dispose wins before repository acquisition instead of acknowledging an absent row', async () => {
    const repositoryReady = deferred<AccountImRepository>()
    const repository = await openImRepository('owner-1', {
      adapter: createMemoryLocalSyncDb(), storage: window.localStorage,
    })
    const io: OutboxWiringIo = {
      getImRepository: () => repositoryReady.promise,
      user: () => ({ id: 'owner-1', nickname: 'Owner', avatarUrl: null }),
      identity: () => undefined,
      chats: () => [], chatShown: () => false, activeThreadRootId: () => null,
      setMessagesAndCache: () => {}, setThreadMessages: () => {}, patchChat: () => {},
      toast: () => {},
      appendMessage: () => {},
    }
    const wiring = createOutboxWiring(io)
    const enqueue = wiring.enqueue(enqueueInput('11111111-1111-4111-8111-111111111111'))

    wiring.dispose()
    repositoryReady.resolve(repository)

    await expect(enqueue).rejects.toThrow(/disposed before durable enqueue/i)
    expect(box.items().filter((item) => item.kind === 'chatMessage')).toEqual([]) // the read position a send advances is its own write
  })

  it('commits the RPC row directly without a getMessageById round trip', async () => {
    const row = persistedMessage('message-4')
    vi.spyOn(chatService, 'sendMessage').mockResolvedValue(row)
    vi.spyOn(chatService, 'getMessageById')
    const harness = wiringHarness(row.id)

    await harness.wiring.enqueue(enqueueInput(row.id))
    await flushMicrotasks()

    await vi.waitFor(() => {
      expect(harness.messages()[0]).toMatchObject({ id: row.id, seq: 42, local_send_state: null })
    })
    expect(chatService.sendMessage).toHaveBeenCalledTimes(1)
    expect(chatService.getMessageById).not.toHaveBeenCalled()
    expect(harness.messages()).toHaveLength(1)
    expect(harness.toast).not.toHaveBeenCalled()
  })

  // @@@4439 — 权威 row 必须经 store 的单行摄入 chokepoint(appendMessage)落窗,那里承载跳号重验证;
  // 若 wiring 绕开它直接 setMessagesAndCache,交错落库的入站行会沉到增量游标下方、三路取数全部漏掉。
  it('routes the authoritative ack row through the store ingestion chokepoint (#4439)', async () => {
    const row = persistedMessage('message-5') // 权威 seq=42
    vi.spyOn(chatService, 'sendMessage').mockResolvedValue(row)
    const harness = wiringHarness(row.id)

    await harness.wiring.enqueue(enqueueInput(row.id))
    await vi.waitFor(() => {
      expect(harness.appendMessage).toHaveBeenCalledWith({ ...row,
        local_timeline: { afterSeq: 0, createdAt: expect.any(String) } })
    })
    expect(harness.appendMessage).toHaveBeenCalledTimes(1)
    // #1884 — 水位推进不等重验证:appendMessage(同步返回)之后同一 tick 就推进。
    await vi.waitFor(() => {
      expect(harness.messages().find((m) => m.id === row.id)).toMatchObject({ seq: 42 })
    })
  })

  it('summarizes reference blocks in the send acknowledgement without including inaccessible widget text', async () => {
    const row = persistedMessage('reference-preview')
    row.content = 'gugu-widget://private\n\ngugu-chat://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222'
    vi.spyOn(chatService, 'sendMessage').mockResolvedValue(row)
    const harness = wiringHarness(row.id)
    await harness.wiring.enqueue({ ...enqueueInput(row.id), content: row.content })
    await vi.waitFor(() => expect(harness.patchChat).toHaveBeenCalledWith('chat-1', expect.objectContaining({
      last_message_preview: '[引用]\n\n[引用消息]',
    })))
    expect(harness.messages()[0]?.content).toBe(row.content)
  })
})

describe('投递前置:乐观行先上屏,就绪/对端解析在投递阶段 (C1/C2)', () => {
  it('C2 私聊对端未就绪:enqueue 不等对端解析,投递时解析并按对端投递', async () => {
    const row = persistedMessage('message-c2')
    const peer = deferred<string | null>()
    vi.spyOn(chatService, 'getDmPeerUserId').mockReturnValue(peer.promise)
    const send = vi.spyOn(chatService, 'sendMessage').mockResolvedValue(row)
    const harness = wiringHarness(row.id)

    await harness.wiring.enqueue({ ...enqueueInput(row.id), toUserIds: null, resolveDmPeer: true })
    // enqueue 已返回、乐观行在屏上「发送中」,对端解析还在路上,没有投出去
    expect(harness.messages()[0]).toMatchObject({ id: row.id, local_send_state: 'sending' })
    await vi.waitFor(() => expect(chatService.getDmPeerUserId).toHaveBeenCalledWith('chat-1', 'owner-1'))
    expect(send).not.toHaveBeenCalled()

    peer.resolve('agent-9')
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send.mock.calls[0]![5]).toMatchObject({ toUserIds: ['agent-9'] })
    await vi.waitFor(() => expect(harness.messages()[0]).toMatchObject({ seq: 42, local_send_state: null }))
  })

  it('C2 对端解析不到 → 气泡变「未送达」,消息从未以 null 收件人投出', async () => {
    vi.useFakeTimers()
    vi.spyOn(chatService, 'getDmPeerUserId').mockResolvedValue(null)
    const send = vi.spyOn(chatService, 'sendMessage')
    const harness = wiringHarness('message-c2-missing')

    await harness.wiring.enqueue({ ...enqueueInput('message-c2-missing'), toUserIds: null, resolveDmPeer: true })
    await vi.advanceTimersByTimeAsync(25_000)

    expect(send).not.toHaveBeenCalled()
    expect(harness.messages()[0]).toMatchObject({ id: 'message-c2-missing', local_send_state: 'failed' })
  })

  it('C1 投递前置在投递前跑、不挡乐观行;前置失败 → 未送达,手动重试再跑一次前置', async () => {
    vi.useFakeTimers()
    const row = persistedMessage('message-c1')
    const send = vi.spyOn(chatService, 'sendMessage').mockResolvedValue(row)
    let ready = false
    const beforeDeliver = vi.fn(async () => { if (!ready) throw new Error('session not ready') })
    const harness = wiringHarness(row.id)

    await harness.wiring.enqueue({ ...enqueueInput(row.id), beforeDeliver })
    expect(harness.messages()[0]).toMatchObject({ id: row.id, local_send_state: 'sending' })
    await vi.advanceTimersByTimeAsync(25_000)
    expect(beforeDeliver).toHaveBeenCalledTimes(4) // 首发加 3 次重试,每次先过前置
    expect(send).not.toHaveBeenCalled()
    expect(harness.messages()[0]).toMatchObject({ local_send_state: 'failed', local_send_error: 'session not ready' })
    expect(harness.toast).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ error: 'session not ready' }), 'message send failed')

    ready = true
    harness.wiring.retrySend(row.id)
    await vi.advanceTimersByTimeAsync(100)
    expect(beforeDeliver).toHaveBeenCalledTimes(5)
    expect(send).toHaveBeenCalledTimes(1)
    expect(harness.messages()[0]).toMatchObject({ seq: 42, local_send_state: null })
  })

  it.each(['zh-CN', 'en-US'] as const)('names the original conversation in an off-screen failure (%s)', async (locale) => {
    setLocalePreference(locale)
    vi.useFakeTimers()
    const harness = wiringHarness('offscreen', {
      chatShown: () => false,
      chats: () => [chat({ id: 'chat-1', kind: 'group', name: 'Research files', alias: '论文附件' })],
    })
    await harness.wiring.enqueue({ ...enqueueInput('offscreen'), beforeDeliver: async () => { throw new Error('private transport error') } })
    await vi.advanceTimersByTimeAsync(25_000)
    expect([...notices.visible.values()]).toEqual([locale === 'zh-CN'
      ? '「论文附件」中的消息未送达，回到该对话可重试或丢弃'
      : 'A message in “论文附件” was not delivered. Return to that conversation to retry or discard it.'])
    harness.wiring.dispose()
  })

  it.each([
    { row: chat({ id: 'chat-1', kind: 'dm', peer_user_id: 'peer', peer_alias: '小林' }), name: '小林' },
    { row: chat({ id: 'chat-1', kind: 'dm', peer_user_id: 'peer' }), name: 'Lin' },
    { row: chat({ id: 'chat-1', kind: 'topic', name: '附件讨论' }), name: '附件讨论' },
    { row: null, name: '会话 chat-1' },
  ])('resolves the off-screen target as $name', async ({ row, name }) => {
    setLocalePreference('zh-CN')
    vi.useFakeTimers()
    const harness = wiringHarness('target-name', {
      chatShown: () => false,
      chats: () => row ? [row] : [],
      identity: () => ({ type: 'human', display_name: 'Lin', avatar: null }),
    })
    await harness.wiring.enqueue({ ...enqueueInput('target-name'), beforeDeliver: async () => { throw new Error('failed') } })
    await vi.advanceTimersByTimeAsync(25_000)
    expect([...notices.visible.values()]).toEqual([`「${name}」中的消息未送达，回到该对话可重试或丢弃`])
    harness.wiring.dispose()
  })
})

describe('resolveOutboxRecipients (C2)', () => {
  const base = {
    clientMessageId: 'm', chatId: 'chat-1', senderUserId: 'owner-1', state: 'pending', attempts: 0, lastError: null,
    enqueuedAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z',
    payload: { content: 'x', contentType: 'text', toUserIds: null, replyToMessageId: null, threadRootId: null, isThreadRoot: false, isWhisper: false },
  } satisfies OutboxRecord
  it('不需要解析的记录原样返回(同一引用 ⇒ outbox 不重复落盘)', async () => {
    const lookup = vi.fn()
    expect(await resolveOutboxRecipients(base, lookup)).toBe(base)
    const explicit = { ...base, payload: { ...base.payload, toUserIds: ['a'], resolveDmPeer: true } }
    expect(await resolveOutboxRecipients(explicit, lookup)).toBe(explicit)
    expect(lookup).not.toHaveBeenCalled()
  })
  it('解析成功写回 toUserIds 并清掉标记;查询失败原样抛出(不吞成「收件人不可用」)', async () => {
    const pending = { ...base, payload: { ...base.payload, resolveDmPeer: true } }
    const resolved = await resolveOutboxRecipients(pending, async () => 'peer-1')
    expect(resolved.payload).toMatchObject({ toUserIds: ['peer-1'], resolveDmPeer: false })
    await expect(resolveOutboxRecipients(pending, async () => { throw new Error('network down') })).rejects.toThrow('network down')
  })
})

const endpoint = { supabaseUrl: 'https://db.test', anonKey: 'anon', token: 'token' }
const nativeCommit = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ message_id: id, chat_id: 'chat-1', sender_user_id: 'owner-1', file_name: name, to_user_ids: [], ...extra })

it('confirms a native send whose file is gone (a restart) by reading its message back, never publishing again', async () => {
  const f = wiringHarness('native-restart')
  const persisted = { ...persistedMessage('native-restart'), content_type: 'attachment' as const }
  const read = vi.spyOn(chatService, 'getMessageById').mockResolvedValue(persisted)
  const publish = vi.spyOn(attachmentEndpoint, 'commitPreparedChatAttachment')
  const now = new Date().toISOString()
  // What a previous run left: the row committed for native publication, its File gone with that run.
  await f.wiring.outbox.enqueue({ clientMessageId: persisted.id, chatId: 'chat-1', senderUserId: 'owner-1',
    payload: { content: 'native.txt', contentType: 'attachment', toUserIds: [], replyToMessageId: null, threadRootId: null, isThreadRoot: false, isWhisper: false },
    operation: { kind: 'nativeAttachment', commit: nativeCommit(persisted.id, 'native.txt') },
    state: 'pending', attempts: 0, lastError: null, enqueuedAt: now, updatedAt: now })
  await vi.waitFor(() => expect(f.appendMessage).toHaveBeenCalledWith(expect.objectContaining({ id: persisted.id, seq: 42 })))
  expect(read).toHaveBeenCalledWith(persisted.id, 'owner-1')
  expect(publish).not.toHaveBeenCalled()
  expect(box.items().filter((item) => item.kind === 'chatMessage')).toEqual([]) // the read position a send advances is its own write
  f.wiring.dispose()
})

it('publishes a native file in its chat lane with no request deadline; what was sent after it waits for it', async () => {
  vi.useFakeTimers()
  const f = wiringHarness('native-slow')
  const publication = deferred<Record<string, unknown>>()
  const publish = vi.spyOn(attachmentEndpoint, 'commitPreparedChatAttachment').mockReturnValue(publication.promise)
  vi.spyOn(attachmentEndpoint, 'attachmentsEndpoint').mockResolvedValue(endpoint)
  const send = vi.spyOn(chatService, 'sendMessage').mockImplementation(async (_chat, _sender, _content, id) => persistedMessage(id!))
  const native = { ...optimisticMessage('native-slow'), content_type: 'attachment' as const }
  await f.wiring.stageAttachment(native)
  await f.wiring.commitAttachment(native, { local: new File(['bytes'], 'large.txt') }, nativeCommit(native.id, 'large.txt'))
  await f.wiring.enqueue(enqueueInput('later-text'))
  await vi.advanceTimersByTimeAsync(60_000) // far past the 20 s request deadline: a native publication hashes the file first
  expect(publish).toHaveBeenCalledOnce()
  expect(send, 'later text keeps its place behind the file').not.toHaveBeenCalled()
  expect(box.get('native-slow')?.state).toBe('sending')
  publication.resolve({ ...persistedMessage(native.id), content_type: 'attachment' })
  await vi.advanceTimersByTimeAsync(10)
  expect(f.messages().find(row => row.id === native.id)?.seq).toBe(42)
  expect(send).toHaveBeenCalledOnce()
  expect(box.items().filter((item) => item.kind === 'chatMessage')).toEqual([]) // the read position a send advances is its own write
  f.wiring.dispose()
})

it('does not publish a native reply discarded while its source is still uploading', async () => {
  const f = wiringHarness('native-waiting')
  const publish = vi.spyOn(attachmentEndpoint, 'commitPreparedChatAttachment')
  const source = { ...optimisticMessage('uploading-source'), content_type: 'attachment' as const }
  const native = { ...optimisticMessage('native-waiting'), reply_to_message_id: source.id, content_type: 'attachment' as const }
  await f.wiring.stageAttachment(source)
  await f.wiring.stageAttachment(native)
  await f.wiring.commitAttachment(native, { local: new File(['bytes'], 'reply.txt') }, nativeCommit(native.id, 'reply.txt', { reply_to_message_id: source.id }))
  await flushMicrotasks(30)
  expect(publish).not.toHaveBeenCalled()
  await f.wiring.outbox.discard(native.id)
  await flushMicrotasks(30)
  expect(publish).not.toHaveBeenCalled()
  expect(outboxRows().map(row => row.clientMessageId)).toEqual([source.id])
  f.wiring.dispose()
})

it('sends a failed row again when the backend recovers, not while it kept answering', async () => {
  vi.useFakeTimers()
  const f = wiringHarness('outage-row')
  const send = vi.spyOn(chatService, 'sendMessage').mockRejectedValue(new Error('Failed to fetch'))
  await f.wiring.enqueue(enqueueInput('outage-row'))
  await vi.advanceTimersByTimeAsync(25_000)
  expect(f.messages()[0]).toMatchObject({ id: 'outage-row', local_send_state: 'failed' })
  expect(send).toHaveBeenCalledTimes(4)
  send.mockImplementation(async (_chat, _sender, _content, id) => persistedMessage(id!))
  noteBackendAnswer(true) // the backend kept answering: no recovery edge, no resend loop
  await vi.advanceTimersByTimeAsync(10)
  expect(send).toHaveBeenCalledTimes(4)
  noteBackendAnswer(false)
  noteBackendAnswer(true)
  await vi.advanceTimersByTimeAsync(10)
  expect(send).toHaveBeenCalledTimes(5)
  expect(box.items().filter((item) => item.kind === 'chatMessage')).toEqual([]) // the read position a send advances is its own write
  f.wiring.dispose()
})

it('a send that fails asks the beat to pull now, so an outage shorter than one beat is still seen', async () => {
  const pull = vi.fn()
  const unbind = bindBackendProbe(pull)
  const f = wiringHarness('probe-row')
  vi.spyOn(chatService, 'sendMessage').mockRejectedValue(new Error('Failed to fetch'))
  vi.useFakeTimers()
  try {
    await f.wiring.enqueue(enqueueInput('probe-row'))
    await vi.advanceTimersByTimeAsync(25_000)
  } finally { vi.useRealTimers() }
  await vi.waitFor(() => expect(pull).toHaveBeenCalledOnce())
  unbind()
  f.wiring.dispose()
})
it('a failed upload whose bytes this run holds is resent from its own row; after a reload the file must be selected again', async () => {
  const f = wiringHarness('upload-1')
  const row = { ...optimisticMessage('upload-1'), content_type: 'attachment' as const }
  await f.wiring.stageAttachment(row)
  const retry = vi.fn()
  await f.wiring.failAttachmentUpload('upload-1', new Error('network lost'), '发送未完成，请稍后重新发送', retry)
  expect(f.messages().find(m => m.id === 'upload-1')).toMatchObject({ local_send_state: 'failed', local_send_error: '发送未完成，请稍后重新发送', local_send_retryable: true })
  f.wiring.retrySend('upload-1')
  await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce())
  expect(f.messages().find(m => m.id === 'upload-1')?.local_send_state).toBe('sending')
  expect(outboxRows()).toEqual([expect.objectContaining({ clientMessageId: 'upload-1', state: 'uploading', lastError: null })])
  f.wiring.retrySend('upload-1')
  await flushMicrotasks(30)
  expect(retry, 'an upload already going again is not started twice').toHaveBeenCalledOnce()
  await f.wiring.failAttachmentUpload('upload-1', new Error('network lost'), '发送未完成，请稍后重新发送', retry)
  f.wiring.dispose()
  let restored: MessageItem[] = []
  const g = createOutboxWiring({ getImRepository: () => f.repository, user: () => ({ id: 'owner-1', nickname: 'Owner', avatarUrl: null }), identity: () => undefined, chats: () => [],
    chatShown: (id) => id === 'chat-1', activeThreadRootId: () => null, setMessagesAndCache: (updater) => { restored = updater(restored) }, setThreadMessages: () => {},
    patchChat: f.patchChat, toast: f.toast, appendMessage: f.appendMessage })
  g.restoreAndWatch()
  await vi.waitFor(() => expect(restored.find(m => m.id === 'upload-1')).toMatchObject({ local_send_state: 'failed', local_send_retryable: false, local_send_error: '上传已中断，请重新选择文件。' }))
  g.dispose()
})
it('text sent with a file is delivered after that file, never before it', async () => {
  const f = wiringHarness('file-1')
  const publication = deferred<Record<string, unknown>>()
  vi.spyOn(attachmentEndpoint, 'commitPreparedChatAttachment').mockReturnValue(publication.promise)
  vi.spyOn(attachmentEndpoint, 'attachmentsEndpoint').mockResolvedValue(endpoint)
  const send = vi.spyOn(chatService, 'sendMessage').mockImplementation(async (_chat, _sender, _content, id) => persistedMessage(id!))
  const file = { ...optimisticMessage('file-1'), content_type: 'attachment' as const }
  await f.wiring.stageAttachment(file)
  await f.wiring.enqueue({ ...enqueueInput('caption-text'), dependsOn: 'file-1' })
  expect(outboxRows()).toContainEqual(expect.objectContaining({ clientMessageId: 'caption-text', dependsOn: 'file-1' }))
  await flushMicrotasks(30)
  expect(send).not.toHaveBeenCalled()
  await f.wiring.commitAttachment(file, { local: new File(['bytes'], 'notes.txt') }, nativeCommit(file.id, 'notes.txt'))
  await flushMicrotasks(30)
  expect(send, 'the text waits while its file is still being published').not.toHaveBeenCalled()
  publication.resolve({ ...persistedMessage(file.id), content_type: 'attachment' })
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
  expect(send.mock.calls[0][3]).toBe('caption-text')
  f.wiring.dispose()
})
it('a native publication that keeps failing is shown failed and resent from its row while this run holds the file', async () => {
  vi.useFakeTimers()
  const f = wiringHarness('native-refused')
  const publish = vi.spyOn(attachmentEndpoint, 'commitPreparedChatAttachment').mockRejectedValue(new Error('file host unavailable'))
  vi.spyOn(attachmentEndpoint, 'attachmentsEndpoint').mockResolvedValue(endpoint)
  vi.spyOn(chatService, 'getMessageById').mockResolvedValue(null)
  const native = { ...optimisticMessage('native-refused'), content_type: 'attachment' as const }
  await f.wiring.stageAttachment(native)
  await f.wiring.commitAttachment(native, { local: new File(['bytes'], 'plan.txt') }, nativeCommit(native.id, 'plan.txt'))
  await vi.advanceTimersByTimeAsync(25_000)
  expect(f.messages().find(m => m.id === native.id)).toMatchObject({ local_send_state: 'failed', local_send_retryable: true })
  expect(publish).toHaveBeenCalledTimes(4)
  publish.mockResolvedValue({ ...persistedMessage(native.id), content_type: 'attachment' })
  f.wiring.retrySend(native.id)
  await vi.advanceTimersByTimeAsync(10)
  expect(publish).toHaveBeenCalledTimes(5)
  expect(f.messages().find(m => m.id === native.id)?.seq).toBe(42)
  f.wiring.dispose()
})

it('keeps a refused nonfriend DM failed and puts its cause in the existing offscreen notice', async () => {
  setLocalePreference('zh-CN')
  vi.useFakeTimers()
  vi.spyOn(chatService, 'sendMessage').mockRejectedValue(new Error('dm_friendship_required'))
  const h = wiringHarness('not-friends', { chatShown: () => false })
  await h.wiring.enqueue({ ...enqueueInput('not-friends'), toUserIds: ['human-peer'] })
  await vi.advanceTimersByTimeAsync(25_000)
  expect(h.messages()[0]).toMatchObject({ id: 'not-friends', local_send_state: 'failed', local_send_error: 'dm_friendship_required', seq: -1 })
  expect(notices.visible.size).toBe(1)
  expect(notices.show).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ description: '请先添加对方为好友，再发送消息。' }))
  h.wiring.dispose()
})
