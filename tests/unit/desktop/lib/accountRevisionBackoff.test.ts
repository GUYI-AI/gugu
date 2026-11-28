import { afterEach, expect, it, vi } from 'vitest'
import { message } from '../../../support/testHarness'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { openImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { createAccountRevisionCoordinator } from '../../../../apps/desktop/src/lib/accountRevisionCoordinator'
import { clearMessageWindows, initializeMessageWindows, messageWindow } from '../../../../apps/desktop/src/lib/messageWindows'
import { watchRevisionReconcile, type RevisionReconcileSignals } from '../../../../apps/desktop/src/lib/accountRevisionReconcile'

const stops: Array<() => void> = []
afterEach(() => { for (const stop of stops.splice(0)) stop(); clearMessageWindows('viewer'); vi.useRealTimers() })

it('keeps a backoff through news and starts it over when conditions change', async () => {
  vi.useFakeTimers()
  initializeMessageWindows('viewer')
  const repository = await openImRepository('viewer', { adapter: createMemoryLocalSyncDb() })
  await repository.transaction(tx => tx.putSyncState('account-revision-cursor', { revision: '0' }))
  let reachable = false, asked = 0
  let wake!: (head?: string | null) => void
  const coordinator = createAccountRevisionCoordinator('viewer', repository, {
    syncSince: async (cursor) => {
      asked += 1
      if (!reachable) throw new TypeError('Network request failed')
      const id = `row-${asked}`
      return { operations: [{ revision: String(BigInt(cursor) + 1n), event: 'message_created', payload: { chat_id: 'room', entity_id: id,
        message: message({ id, seq: asked, chat_id: 'room', sender_user_id: 'peer', to_user_ids: ['viewer'] }) } }], hasMore: false }
    },
    subscribeWake: (_account, onWake) => { wake = onWake; return () => undefined },
  }, { recover: vi.fn(async () => null), notify: vi.fn(async () => {}) })
  stops.push(() => { coordinator.stop(); repository.close() })
  coordinator.start()
  // Three failed reads grow the backoff to 5 s (1 s, 2 s, 5 s).
  await vi.advanceTimersByTimeAsync(1000 + 2000 + 100)
  expect(asked).toBe(3)
  // News during the backoff is not a read: a channel that still delivers broadcasts must not turn into a retry storm.
  for (let head = 1; head <= 20; head += 1) wake(String(head))
  coordinator.wake()
  await vi.advanceTimersByTimeAsync(100)
  expect(asked).toBe(3)
  // Back online: read now. The read issued in that instant may still fail; the next one comes after the first delay.
  coordinator.resume()
  await vi.advanceTimersByTimeAsync(10)
  expect(asked).toBe(4)
  reachable = true
  await vi.advanceTimersByTimeAsync(1000)
  expect(asked).toBe(5)
  await coordinator.whenIdle()
  expect(messageWindow('viewer', 'room')?.map(item => item.id)).toEqual(['row-5'])
})

it('wakes on the interval and resumes when the page is visible, online or in the foreground again', () => {
  const fired: Record<string, () => void> = {}
  const signals: RevisionReconcileSignals = {
    setInterval: (fn) => { fired.interval = fn; return 1 }, clearInterval: () => undefined,
    onVisible: (listener) => { fired.visible = listener; return () => undefined },
    onOnline: (listener) => { fired.online = listener; return () => undefined },
    onForeground: (listener) => { fired.foreground = listener; return () => undefined },
  }
  const kinds: string[] = []
  watchRevisionReconcile(kind => kinds.push(kind), signals)
  for (const signal of ['interval', 'visible', 'online', 'foreground']) fired[signal]!()
  expect(kinds).toEqual(['wake', 'resume', 'resume', 'resume'])
})
