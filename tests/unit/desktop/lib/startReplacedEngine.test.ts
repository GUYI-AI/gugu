import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startReplacedEngine } from '@/lib/sessionInputOutboxBridge'

const detach = vi.fn()
const sessions = { lifeView: vi.fn(), getSessions: vi.fn(), lifeStart: vi.fn() }
const dormant = { kind: 'dormant', hold: null, pending: { count: 0 } }
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { __GUGU_NATIVE_INPUT_OUTBOX__: { accountId: 'owner', queue: Promise.resolve({ detachFromReplacedEngine: detach }), rows: [], listeners: new Set(), valid: () => true } })
  detach.mockResolvedValue(true)
  sessions.lifeView.mockResolvedValue(dormant)
  sessions.getSessions.mockResolvedValue([{ id: 'session' }, { id: 'other', providerSessionId: 'kept' }])
  sessions.lifeStart.mockResolvedValue(undefined)
})
afterEach(() => { vi.unstubAllGlobals() })
const start = (id = 'session') => startReplacedEngine(sessions as unknown as Parameters<typeof startReplacedEngine>[0], id)

it('starts a dormant session whose engine session was replaced when this device queued input for it', async () => {
  await start()
  expect(detach).toHaveBeenCalledWith('session')
  expect(sessions.lifeStart).toHaveBeenCalledWith('session')
})

it('leaves a session that still has its engine session (an app restart) dormant', async () => {
  await start('other')
  expect(sessions.lifeStart).not.toHaveBeenCalled()
})

it.each([
  { kind: 'dormant', hold: 'user-stop', pending: { count: 0 } },
  { kind: 'failed', hold: 'start-failed', pending: { count: 0 } },
  { kind: 'dormant', hold: null, pending: { count: 1 } },
  { kind: 'ready', hold: null, pending: { count: 0 } },
])('does not start a session in life %j', async life => {
  sessions.lifeView.mockResolvedValue(life)
  await start()
  expect(sessions.getSessions).not.toHaveBeenCalled()
  expect(sessions.lifeStart).not.toHaveBeenCalled()
})

it('does not start when this device has nothing queued for it', async () => {
  detach.mockResolvedValue(false)
  await start()
  expect(sessions.lifeStart).not.toHaveBeenCalled()
})
