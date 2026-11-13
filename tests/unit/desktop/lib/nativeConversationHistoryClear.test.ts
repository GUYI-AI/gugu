// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'

const f = vi.hoisted(() => ({ userId: 'owner', rows: [] as { session: { conversationId: string; chatId: string } }[], changed: new Set<() => void>() }))
vi.mock('../../../../apps/desktop/src/session/shared/remote-sessions/session-directory', () => ({
  directoryDevices: () => [], liveDeviceSessions: () => ({}), directoryRows: () => f.rows,
  subscribeDeviceSessions: (callback: () => void) => { f.changed.add(callback); return () => f.changed.delete(callback) },
}))
vi.mock('../../../../apps/desktop/src/lib/selfIdentityBridge', () => ({ readSelfIdentityBridge: () => ({
  getSnapshot: () => ({ userId: f.userId }), subscribe: (callback: () => void) => { f.changed.add(callback); return () => f.changed.delete(callback) },
}) }))
import { recordNativeConversationHistoryClear, subscribeNativeConversationHistoryClear } from '../../../../apps/desktop/src/lib/nativeConversationHistoryClear'

beforeEach(() => {
  delete (window as unknown as Record<string, unknown>).__GUGU_NATIVE_CONVERSATION_HISTORY_CLEAR__
  f.userId = 'owner'; f.rows = []; f.changed.clear()
})

it('applies a received clear to an already open native session and retains it across directory refreshes without crossing accounts', () => {
  const update = vi.fn(), at = '2026-11-14T00:00:00.000501Z'
  const stop = subscribeNativeConversationHistoryClear('session:native-session', update)
  recordNativeConversationHistoryClear('owner', 'chat', at)
  expect(update).toHaveBeenLastCalledWith(null)
  f.rows = [{ session: { conversationId: 'native-session', chatId: 'chat' } }]
  for (const changed of f.changed) changed()
  expect(update).toHaveBeenLastCalledWith(at)
  recordNativeConversationHistoryClear('owner', 'chat', '2026-11-14T00:00:00.000499Z')
  expect(update).toHaveBeenLastCalledWith(at)
  f.userId = 'other'
  for (const changed of f.changed) changed()
  expect(update).toHaveBeenLastCalledWith(null)
  stop(); expect(f.changed.size).toBe(0)
})
