import { describe, expect, it, vi } from 'vitest'
import type { PublishedFolder } from '../../../../packages/core/src/cloud/chatFolders'
import {
  createChatFoldersPublisher,
  PUBLISH_TIMEOUT_MS,
  REFRESH_MS,
  SETTLE_MS,
} from '../../../../packages/core/src/cloud/chatFoldersPublisher'

// @@@group-folders 这台机器挂在群上的文件夹整份记到账号上(publish_chat_folders)。

const project = (overrides: Partial<PublishedFolder> = {}): PublishedFolder => ({
  folderId: 'p1',
  chatId: 'chat-1',
  path: '/srv/repo',
  attachedAt: null,
  ...overrides,
})

describe('createChatFoldersPublisher', () => {
  function harness(overrides: { auth?: () => Promise<{ accessToken: string; userId: string } | null> } = {}) {
    const timers: { run: () => void; ms: number }[] = []
    const signals: AbortSignal[] = []
    const reply = vi.fn(async () => ({ data: { changed: true, rejected: [] } as unknown, error: null as { message: string } | null }))
    // 与 supabase 的 rpc 同形:返回的请求可以挂上 AbortSignal。
    const rpc = vi.fn((_fn: string, _args: unknown) => {
      const request = { then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => reply().then(ok, bad) }
      return Object.assign(request, { abortSignal: (signal: AbortSignal) => (signals.push(signal), request) })
    })
    const records = vi.fn(async () => [project()])
    const warn = vi.fn()
    const dropBindings = vi.fn(async (_owner: string, _ids: readonly string[]) => {})
    const backend = { probes: 0, recovered: new Set<() => void>() }
    const publisher = createChatFoldersPublisher({
      getAuth: overrides.auth ?? (async () => ({ accessToken: 'token', userId: 'u1' })),
      deviceId: async () => 'dev-1',
      client: () => ({ rpc }) as never,
      records,
      warn,
      dropBindings,
      setTimeout: (run, ms) => {
        const timer = { run, ms }
        timers.push(timer)
        return timer
      },
      clearTimeout: (handle) => {
        const index = timers.indexOf(handle as never)
        if (index >= 0) timers.splice(index, 1)
      },
      backend: {
        writeFailed: () => { backend.probes += 1 },
        onRecovered: (run) => { backend.recovered.add(run); return () => { backend.recovered.delete(run) } },
      },
    })
    const settled = () => new Promise((resolve) => setTimeout(resolve, 0))
    const fire = async () => {
      const timer = timers.shift()
      if (!timer) throw new Error('no timer pending')
      const before = rpc.mock.calls.length + warn.mock.calls.length
      timer.run()
      await vi.waitFor(() => expect(rpc.mock.calls.length + warn.mock.calls.length).toBeGreaterThan(before))
      await settled()
    }
    return { publisher, timers, rpc, reply, signals, records, warn, dropBindings, fire, settled, backend }
  }

  it('settles a burst of changes into one publish, then keeps the account’s copy refreshed', async () => {
    const { publisher, timers, rpc, fire } = harness()
    publisher.notify()
    publisher.notify()
    publisher.notify()
    expect(timers.map((timer) => timer.ms)).toEqual([SETTLE_MS])
    await fire()
    expect(rpc).toHaveBeenCalledTimes(1)
    // 记上之后:隔一阵再记一次(账号上那份可能在这台机器不知道时没了)。
    expect(timers.map((timer) => timer.ms)).toEqual([REFRESH_MS])
    await fire()
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('a stream of changes does not keep deferring the publish (❌ re-arm the settle on every change)', () => {
    const { publisher, timers } = harness()
    publisher.notify()
    const first = timers[0]
    publisher.notify()
    publisher.notify()
    expect(timers).toEqual([first])
  })

  it('a change while waiting to refresh publishes right away (after settling), not at the refresh', async () => {
    const { publisher, timers, fire } = harness()
    publisher.notify()
    await fire()
    expect(timers.map((timer) => timer.ms)).toEqual([REFRESH_MS])
    publisher.notify()
    expect(timers.map((timer) => timer.ms)).toEqual([SETTLE_MS])
  })

  it('retries a failed publish until it lands; a new change does not wait out the retry', async () => {
    const { publisher, timers, rpc, reply, warn, fire } = harness()
    reply.mockResolvedValueOnce({ data: null, error: { message: 'network down' } })
    publisher.notify()
    await fire()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('publish failed'), expect.objectContaining({ error: 'network down' }))
    expect(timers.map((timer) => timer.ms)).toEqual([REFRESH_MS])
    publisher.notify()
    expect(timers.map((timer) => timer.ms)).toEqual([SETTLE_MS])
    await fire()
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(timers.map((timer) => timer.ms)).toEqual([REFRESH_MS])
  })

  it('a failed publish asks for a reading and publishes again on the backend-recovered edge, not on a timer of its own', async () => {
    const { publisher, timers, rpc, reply, fire, backend } = harness()
    reply.mockResolvedValueOnce({ data: null, error: { message: 'network down' } })
    publisher.notify()
    await fire()
    expect(backend.probes).toBe(1)
    expect(timers.map((timer) => timer.ms)).toEqual([REFRESH_MS])
    expect(backend.recovered.size).toBe(1)
    for (const run of [...backend.recovered]) run()
    expect(backend.recovered.size).toBe(0)
    expect(timers.map((timer) => timer.ms)).toEqual([SETTLE_MS])
    await fire()
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(timers.map((timer) => timer.ms)).toEqual([REFRESH_MS])
    expect(backend.recovered.size).toBe(0) // a published copy waits for the refresh only
    publisher.stop()
  })

  it('a publish that hangs is abandoned after the timeout and retried (❌ blocks every later change)', async () => {
    const { publisher, timers, rpc, reply, signals, warn } = harness()
    reply.mockReturnValueOnce(new Promise(() => {}))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      publisher.notify()
      timers.shift()!.run()
      await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1))
      await vi.advanceTimersByTimeAsync(PUBLISH_TIMEOUT_MS)
      expect(signals[0]?.aborted).toBe(true)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('publish failed'), expect.objectContaining({ error: expect.stringMatching(/did not finish/) }))
      expect(timers.map((timer) => timer.ms)).toEqual([REFRESH_MS])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a change during a publish is published again right after', async () => {
    const { publisher, timers, rpc, records } = harness()
    const gate = Promise.withResolvers<PublishedFolder[]>()
    records.mockReturnValueOnce(gate.promise)
    publisher.notify()
    timers.shift()!.run()
    await vi.waitFor(() => expect(records).toHaveBeenCalledTimes(1))
    publisher.notify()
    gate.resolve([project()])
    await vi.waitFor(() => expect(timers.map((timer) => timer.ms)).toEqual([SETTLE_MS]))
    timers.shift()!.run()
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2))
  })

  it('does nothing while signed out (signing in notifies again)', async () => {
    const auth = vi.fn(async () => null)
    const { publisher, rpc, records, timers, settled } = harness({ auth })
    publisher.notify()
    timers.shift()!.run()
    await vi.waitFor(() => expect(auth).toHaveBeenCalledTimes(1))
    await settled()
    expect(records).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
    expect(timers).toEqual([])
  })

  it('bindings the account refused are dropped on this machine and said out loud; a failed drop is retried', async () => {
    const { publisher, timers, reply, warn, dropBindings, fire, backend } = harness()
    reply.mockResolvedValueOnce({ data: { changed: true, rejected: ['p1'] }, error: null })
    publisher.notify()
    await fire()
    expect(dropBindings).toHaveBeenCalledWith('u1', ['p1'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refused'), { rejected: ['p1'] })
    expect(timers.map((timer) => timer.ms)).toEqual([REFRESH_MS])

    reply.mockResolvedValueOnce({ data: { changed: false, rejected: ['p1'] }, error: null })
    dropBindings.mockRejectedValueOnce(new Error('mapping unreadable'))
    await fire()
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('publish failed'), expect.objectContaining({ error: 'mapping unreadable' }))
    // A failed drop is a failed publish: retried on the backend-recovered edge, at the latest on the refresh.
    expect(timers.map((timer) => timer.ms)).toEqual([REFRESH_MS])
    expect(backend.recovered.size).toBe(1)
  })

  it('a machine whose projects cannot be read is retried, ❌ published as an empty list', async () => {
    const { publisher, timers, rpc, records, warn, fire } = harness()
    records.mockRejectedValueOnce(new Error('project group bindings unavailable'))
    publisher.notify()
    await fire()
    expect(rpc).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    expect(timers.map((timer) => timer.ms)).toEqual([REFRESH_MS])
  })

  it('stop() cancels what is pending', () => {
    const { publisher, timers } = harness()
    publisher.notify()
    publisher.stop()
    expect(timers).toEqual([])
    publisher.notify()
    expect(timers).toEqual([])
  })
})

