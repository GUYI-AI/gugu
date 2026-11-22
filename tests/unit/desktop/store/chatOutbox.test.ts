/**
 * Chat sends as the outbox kind `chatMessage` (store/chatOutbox.ts over lib/outbox/core.ts).
 * - pending→sending→sent (the row is removed); failed after 3 retries (1 s / 4 s / 15 s), visible;
 * - idempotency belongs to the writer: the outbox never turns a 409 / unique-key error into a delivery;
 * - a row that died in flight is sent again after a restart;
 * - one lane per chat, one write in flight per lane: a later message never overtakes an earlier one's retry;
 *   another chat is not held up;
 * - discard removes the row; a send in flight that later fails cannot revive it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { noteBackendAnswer } from '@gugu/core/cloud/backendReachability'
import { createOutbox } from '../../../../apps/desktop/src/lib/outbox/core'
import type { OutboxRecord } from '../../../../apps/desktop/src/lib/imRepository'
import { ACCOUNT, chatHarness, deferred, fakeAccount, flush, makeRecord, memoryStorage } from './chatOutboxHarness'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); noteBackendAnswer(true) })

describe('chatOutbox 状态机', () => {
  it('成功路径:pending→sending→sent,行即删', async () => {
    const h = chatHarness(async () => {})
    await h.outbox.enqueue(makeRecord('a'))
    await flush()
    expect(h.events).toEqual(['state:a:pending', 'state:a:sending', 'sent:a'])
    expect(h.storage.rows.size).toBe(0)
  })

  it('#2188 enqueue 落盘失败 leaves no row and the same stable id can be handed back', async () => {
    const delivered: string[] = []
    const h = chatHarness(async (r) => { delivered.push(r.clientMessageId) })
    await h.box.loaded()
    h.storage.failNextWrite = new Error('quota exceeded')
    const ordinaryMessage = makeRecord('stable-message')
    await expect(h.outbox.enqueue(ordinaryMessage)).rejects.toThrow('quota exceeded')
    expect(h.storage.rows.size, 'the composer still owns bytes and id before durable enqueue').toBe(0)
    expect(h.outbox.has('stable-message')).toBe(false)
    await h.outbox.enqueue(ordinaryMessage)
    await flush()
    expect(delivered, 'retry reuses the message id after ownership returns from composer').toEqual(['stable-message'])
    expect(h.storage.rows.size).toBe(0)
  })

  it('commit then response loss keeps one backend row and retry reuses the original id', async () => {
    const messageRows = new Map<string, { id: string; content: string }>()
    const deliveries: string[] = []
    let responseVisible = false
    const h = chatHarness(async (record) => {
      deliveries.push(record.clientMessageId)
      if (!messageRows.has(record.clientMessageId)) messageRows.set(record.clientMessageId, { id: record.clientMessageId, content: record.payload.content })
      if (!responseVisible) throw new Error('response lost after commit')
      return messageRows.get(record.clientMessageId)
    })
    await h.outbox.enqueue(makeRecord('ordinary-message-id'))
    await vi.advanceTimersByTimeAsync(25_000)
    expect(h.row('ordinary-message-id')?.state).toBe('failed')
    expect(messageRows.size).toBe(1)
    expect([...new Set(deliveries)]).toEqual(['ordinary-message-id'])
    responseVisible = true
    await h.outbox.retry('ordinary-message-id')
    await flush()
    expect(h.storage.rows.size).toBe(0)
    expect(messageRows.size, 'idempotent writer converges every retry to one message row').toBe(1)
    expect([...new Set(deliveries)]).toEqual(['ordinary-message-id'])
  })

  it('持续失败:首发加 3 次重试(1s/4s/15s)后 failed,行保留可见', async () => {
    let calls = 0
    const h = chatHarness(async () => { calls += 1; throw new Error('boom') })
    await h.outbox.enqueue(makeRecord('a'))
    await flush()
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(calls).toBe(3)
    expect(h.row('a')?.state).toBe('pending')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(calls).toBe(4)
    expect(h.row('a')).toMatchObject({ state: 'failed', attempts: 4, lastError: 'boom' })
    expect(h.events.at(-1)).toBe('state:a:failed')
  })

  it('raw 409/唯一键错误不能由 outbox 吞成送达', async () => {
    const h = chatHarness(async () => { throw new Error('duplicate key value violates unique constraint "messages_client_dedup"') })
    await h.outbox.enqueue(makeRecord('a'))
    await vi.advanceTimersByTimeAsync(25_000)
    expect(h.events.at(-1)).toBe('state:a:failed')
    expect(h.events).not.toContain('sent:a')
    expect(h.row('a')?.lastError).toContain('messages_client_dedup')
  })

  it('服务端拒绝(私聊未成好友 42501):一次即 failed,带原因;重启不再重投', async () => {
    let calls = 0
    const refusal = { code: '42501', message: 'dm_friendship_required', hint: 'dm_friendship_required' }
    const h = chatHarness(async () => { calls += 1; throw new Error(refusal.message, { cause: refusal }) })
    await h.outbox.enqueue(makeRecord('a'))
    await vi.advanceTimersByTimeAsync(25_000)
    expect(calls).toBe(1)
    expect(h.row('a')).toMatchObject({ state: 'failed', attempts: 1, lastError: 'dm_friendship_required' })
    expect(h.storage.rows.get(`${ACCOUNT}/a`)?.failure?.reason).toBe('rejected')
    h.outbox.dispose(); h.box.dispose()
    const again = chatHarness(async () => { calls += 1 }, {}, { storage: h.storage })
    await again.box.loaded()
    await flush()
    expect(calls).toBe(1)
    expect(again.row('a')?.state).toBe('failed')
  })

  it('瞬断恢复:第 2 次尝试成功 → sent', async () => {
    let calls = 0
    const h = chatHarness(async () => { calls += 1; if (calls === 1) throw new Error('transient') })
    await h.outbox.enqueue(makeRecord('a'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls).toBe(2)
    expect(h.events.at(-1)).toBe('sent:a')
  })

  it('FIFO 单在途:后一条不得越过前一条的重试期;别的会话照常', async () => {
    const order: string[] = []
    let aCalls = 0
    const h = chatHarness(async (rec) => {
      order.push(rec.clientMessageId)
      if (rec.clientMessageId === 'a' && (aCalls += 1) === 1) throw new Error('transient')
    })
    await h.outbox.enqueue(makeRecord('a'))
    await h.outbox.enqueue(makeRecord('b'))
    await h.outbox.enqueue(makeRecord('x', { chatId: 'chat-2' }))
    await flush()
    expect(order).toEqual(['a', 'x'])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(order).toEqual(['a', 'x', 'a', 'b'])
  })

  it('C5 按会话分道:一个会话卡在投递里,另一个会话的消息照常送达', async () => {
    const stuck = deferred()
    const order: string[] = []
    const h = chatHarness(async (rec) => {
      order.push(rec.clientMessageId)
      if (rec.chatId === 'chat-stuck') await stuck.promise
    })
    await h.outbox.enqueue(makeRecord('s1', { chatId: 'chat-stuck' }))
    await h.outbox.enqueue(makeRecord('s2', { chatId: 'chat-stuck' }))
    await h.outbox.enqueue(makeRecord('o1', { chatId: 'chat-other' }))
    await flush()
    expect(h.events).toContain('sent:o1')
    expect(order).toEqual(['s1', 'o1'])
    expect(h.row('s2')?.state).toBe('pending')
    stuck.resolve()
    await flush()
    expect(order).toEqual(['s1', 'o1', 's2'])
    expect(h.events.filter((e) => e.startsWith('sent:'))).toEqual(['sent:o1', 'sent:s1', 'sent:s2'])
  })

  it('C1/C2 prepare:每次尝试先过前置,改写的记录用于这一次投递;前置在途时丢弃不复活', async () => {
    const delivered: OutboxRecord[] = []
    const gate = deferred()
    const h = chatHarness(async (r) => { delivered.push(r) }, {
      prepare: async (r) => {
        if (r.clientMessageId === 'held') { await gate.promise; return r }
        return { ...r, payload: { ...r.payload, toUserIds: ['peer'] } }
      },
    })
    await h.outbox.enqueue(makeRecord('a'))
    await h.outbox.enqueue(makeRecord('held', { chatId: 'chat-2' }))
    await flush()
    expect(delivered.map((r) => [r.clientMessageId, r.payload.toUserIds])).toEqual([['a', ['peer']]])
    await h.outbox.discard('held')
    gate.resolve()
    await flush()
    expect(delivered).toHaveLength(1)
    expect(h.row('held')).toBeUndefined()
  })

  it('prepare 不计入投递期限:慢的前置不会被 20 s 截止判失败', async () => {
    const gate = deferred()
    const delivered: string[] = []
    const h = chatHarness(async (r) => { delivered.push(r.clientMessageId) }, { prepare: async (r) => { await gate.promise; return r } })
    await h.outbox.enqueue(makeRecord('a'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.row('a')?.state).toBe('sending')
    gate.resolve()
    await flush()
    expect(delivered).toEqual(['a'])
  })

  it('手动 retry:failed→pending 重投,attempts 归零重新获得自动重试预算', async () => {
    let fail = true
    const h = chatHarness(async () => { if (fail) throw new Error('down') })
    await h.outbox.enqueue(makeRecord('a'))
    await vi.advanceTimersByTimeAsync(25_000)
    expect(h.row('a')?.state).toBe('failed')
    fail = false
    await h.outbox.retry('a')
    await flush()
    expect(h.events.at(-1)).toBe('sent:a')
    expect(h.storage.rows.size).toBe(0)
  })

  it('后端恢复:没送到的 failed 行自动重投', async () => {
    let fail = true
    const h = chatHarness(async () => { if (fail) throw new Error('down') })
    await h.outbox.enqueue(makeRecord('a'))
    await h.outbox.enqueue(makeRecord('b', { chatId: 'chat-2' }))
    await vi.advanceTimersByTimeAsync(25_000)
    expect(h.row('a')?.state).toBe('failed')
    expect(h.row('b')?.state).toBe('failed')
    fail = false
    noteBackendAnswer(false)
    noteBackendAnswer(true)
    await flush()
    expect(h.storage.rows.size).toBe(0)
  })

  it('discard:删行 + 回调;已 failed 行丢弃后恢复时也不再重投', async () => {
    const h = chatHarness(async () => { throw new Error('down') })
    await h.outbox.enqueue(makeRecord('a'))
    await vi.advanceTimersByTimeAsync(25_000)
    await h.outbox.discard('a')
    expect(h.events.at(-1)).toBe('discarded:a')
    expect(h.storage.rows.size).toBe(0)
    noteBackendAnswer(false)
    noteBackendAnswer(true)
    await flush()
    expect(h.events.filter((e) => e === 'sent:a')).toEqual([])
  })

  it("restart:'sending' 行(死在投递中)重投并送达;failed 行留着", async () => {
    const storage = memoryStorage()
    const first = chatHarness(() => new Promise(() => {}), {}, { storage })
    await first.outbox.enqueue(makeRecord('a'))
    await first.outbox.enqueue(makeRecord('b', { chatId: 'chat-2' }))
    await flush()
    first.box.dispose()
    const failed = storage.rows.get(`${ACCOUNT}/b`)!
    storage.rows.set(`${ACCOUNT}/b`, { ...failed, state: 'failed', failure: { reason: 'rejected', message: 'no' } })
    expect(storage.rows.get(`${ACCOUNT}/a`)?.state).toBe('sending')
    const second = chatHarness(async () => {}, {}, { storage })
    const restored = await second.outbox.restore()
    // The drain may already have picked it up again by the time the rows are read back.
    expect(restored.map((r) => `${r.clientMessageId}:${r.state === 'failed' ? 'failed' : 'going'}`).sort()).toEqual(['a:going', 'b:failed'])
    await flush()
    expect(second.events).toContain('sent:a')
    expect(second.row('b')?.state).toBe('failed')
  })

  it('restart:上传中的行(字节只在上一个进程里)变成要重新选文件的 failed', async () => {
    const storage = memoryStorage()
    const first = chatHarness(async () => {}, {}, { storage })
    await first.outbox.stageUpload(makeRecord('file', { operation: { kind: 'upload' } }))
    first.box.dispose()
    const second = chatHarness(async () => {}, {}, { storage })
    const [restored] = await second.outbox.restore()
    expect(restored).toMatchObject({ clientMessageId: 'file', state: 'failed', operation: { kind: 'upload' } })
    expect(restored!.lastError).toBeTruthy()
  })

  it('投递超时(20 s)→ 按失败处理(挂起黑洞治理)', async () => {
    let calls = 0
    const signals: AbortSignal[] = []
    const h = chatHarness((_r, signal) => { calls += 1; signals.push(signal); return new Promise<never>(() => {}) })
    await h.outbox.enqueue(makeRecord('a'))
    await vi.advanceTimersByTimeAsync(20_000 + 1_000 + 20_000 + 4_000 + 20_000 + 15_000 + 20_000)
    expect(calls).toBe(4)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(h.row('a')?.state).toBe('failed')
    expect(h.row('a')?.lastError).toBeTruthy()
  })

  it('换号:在途的投递被中止,不进 ack、不回调 UI,行留在原账号名下', async () => {
    const account = fakeAccount()
    const started = deferred()
    const release = deferred()
    let ackCalls = 0
    const h = chatHarness(async () => { started.resolve(); await release.promise }, { ack: async () => { ackCalls += 1 } }, { account })
    await h.outbox.enqueue(makeRecord('account-a-pending'))
    await started.promise
    const eventsBefore = [...h.events]
    account.set('user-2')
    release.resolve()
    await vi.advanceTimersByTimeAsync(25_000)
    expect(ackCalls).toBe(0)
    expect(h.events).toEqual(eventsBefore)
    expect(h.row('account-a-pending')).toBeDefined()
  })
})

describe('评审修复回归锁(#1762 review)', () => {
  it('[3] onSent 挂起不得卡死队列:后续消息照常投递', async () => {
    let sentCount = 0
    const h = chatHarness(async () => {}, { onSent: () => { sentCount += 1; return new Promise<never>(() => {}) } })
    await h.outbox.enqueue(makeRecord('a'))
    await h.outbox.enqueue(makeRecord('b'))
    await flush()
    expect(sentCount).toBe(2)
    expect(h.storage.rows.size).toBe(0)
  })

  it('[5] 投递在途时丢弃 → 不得被失败分支复活(行/库均不残留)', async () => {
    const inflight: { reject?: (err: Error) => void } = {}
    const h = chatHarness(() => new Promise<void>((_res, rej) => { inflight.reject = rej }))
    await h.outbox.enqueue(makeRecord('a'))
    await flush()
    await h.outbox.discard('a')
    inflight.reject?.(new Error('boom'))
    await vi.advanceTimersByTimeAsync(25_000)
    expect(h.row('a'), '丢弃后失败分支不得把行写回持久层').toBeUndefined()
    expect(h.events.filter((e) => e.startsWith('state:a:failed'))).toEqual([])
    expect(h.events.at(-1)).toBe('discarded:a')
  })

  it('[6] delivered():送达 resolve;终态 failed reject;对已 failed 行立即 reject', async () => {
    const ok = chatHarness(async () => {})
    await ok.outbox.enqueue(makeRecord('a'))
    const p = ok.outbox.delivered('a')
    await flush()
    await expect(p).resolves.toBeUndefined()
    const bad = chatHarness(async () => { throw new Error('down') })
    await bad.outbox.enqueue(makeRecord('x'))
    const pxErr = bad.outbox.delivered('x').then(() => null, (e: Error) => e)
    await vi.advanceTimersByTimeAsync(25_000)
    expect((await pxErr)?.message).toBe('down')
    await expect(bad.outbox.delivered('x'), '已是 failed 终态 → 立即 reject 不挂等待者').rejects.toThrow('down')
  })

  it('一个账号只有一个发件箱:两个聊天门面共享同一张表时,同 id 不会被入队两次', async () => {
    const storage = memoryStorage()
    const box = createOutbox({ storage, account: fakeAccount(), online: () => () => {} })
    const h = chatHarness(async () => new Promise(() => {}), {}, { storage, box })
    await h.outbox.enqueue(makeRecord('once'))
    await expect(h.outbox.enqueue(makeRecord('once'))).rejects.toThrow()
  })
})
