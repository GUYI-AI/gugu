// @vitest-environment jsdom
import { notifyManager } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * This device's settings follow changes made anywhere (another window, the main process): main says which key changed
 * and every window reads it again — except a key the window is writing itself, whose write settles with its own read
 * (I4: a read landing mid-edit must not put the older stored value over the one being typed).
 */
const ipc = vi.hoisted(() => {
  const listeners = new Set<(data: { key: string }) => void>()
  const stored: Record<string, unknown> = { interface: { hideContextBar: false }, terminal: { enabled: true }, browser: { profiles: [{ id: 'profile-1', name: 'Work' }] } }
  return {
    listeners,
    stored,
    getWithMeta: vi.fn(async (key: string) => ({ value: stored[key], defaults: {}, overrides: {} })),
    getAll: vi.fn(async () => Object.fromEntries(Object.entries(stored).map(([key, value]) => [key, { value, defaults: {}, overrides: {} }]))),
  }
})
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { appSettings: { getWithMeta: ipc.getWithMeta, getAll: ipc.getAll } },
  rpcOn: () => ({ appSettings: { getWithMeta: ipc.getWithMeta } }),
  events: { on: (_channel: unknown, cb: (data: { key: string }) => void) => { ipc.listeners.add(cb); return () => ipc.listeners.delete(cb) } },
}))
vi.mock('@/lib/errorSummaryReporting', () => ({ reportHandledError: vi.fn() }))

type Client = typeof import('../../../../apps/desktop/src/session/renderer/features/settings/app-settings-client')
let client: Client
const broadcast = (key: string) => { for (const listener of ipc.listeners) listener({ key }) }
/** Bounded microtask turns until `seen` holds: no clock, and a read that never starts fails loudly. */
async function turnsUntil(seen: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200 && !seen(); turn += 1) await Promise.resolve()
  expect(seen()).toBe(true)
}
const readsOf = (key: string) => ipc.getWithMeta.mock.calls.filter(([read]) => read === key).length

beforeEach(async () => {
  notifyManager.setScheduler((callback) => { callback() })
  localStorage.clear()
  vi.resetModules()
  ipc.listeners.clear()
  ipc.stored.interface = { hideContextBar: false }
  client = await import('../../../../apps/desktop/src/session/renderer/features/settings/app-settings-client')
  await client.prefetchAllAppSettings()
})
afterEach(async () => { (await import('../../../../apps/desktop/src/lib/replica')).queryClient.clear() })

describe('appSettings changes made elsewhere', () => {
  it('a key another window changed is read again', async () => {
    ipc.stored.interface = { hideContextBar: true }
    broadcast('interface')
    await vi.waitFor(() => expect(client.getAppSettingValueSnapshot('interface')).toEqual({ hideContextBar: true }))
  })

  it('a key this window is writing is not read back over the edit; its own write settles it', async () => {
    const done = client.beginAppSettingsWrite('interface')
    client.setAppSettingsValueInCache('interface', { hideContextBar: true } as never)
    // The main process answered an earlier write: its broadcast arrives while the newer edit is still on its way.
    const reads = readsOf('interface')
    broadcast('interface')
    // Control: a key nobody is writing, broadcast right after, is read — by then a read of `interface` would have started.
    const terminalReads = readsOf('terminal')
    broadcast('terminal')
    await turnsUntil(() => readsOf('terminal') > terminalReads)
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
    expect(readsOf('interface')).toBe(reads)
    expect(client.getAppSettingValueSnapshot('interface')).toEqual({ hideContextBar: true })
    done()
  })

  it('another machine\'s settings are not kept across restarts, and do not push this device\'s keys out', async () => {
    for (let n = 0; n < 10; n += 1) await client.remoteAppSettingsModel.prefetch('localProject', `machine-${n}`)
    const kept = Object.values(JSON.parse(localStorage.getItem('gugu.readModel.v1:device') ?? '{}') as Record<string, { key: unknown[] }>)
    expect(kept.filter((entry) => entry.key[0] === 'remoteAppSettings')).toEqual([])
    // No preload handover here (web): `interface` keeps its first frame from the snapshot; on desktop it is handed over.
    expect(kept.filter((entry) => entry.key[0] === 'appSettings').map((entry) => entry.key[2])).toEqual(['interface', 'terminal'])
  })
})

describe('what of the settings is kept across restarts (review B1-3)', () => {
  it('the browser key (profiles without an upper bound) is not kept, even while small; a drawn key like terminal is', async () => {
    const block = JSON.parse(localStorage.getItem('gugu.readModel.v1:device') ?? '{}') as Record<string, { key: unknown[] }>
    const keys = Object.values(block).filter((entry) => entry.key[0] === 'appSettings').map((entry) => entry.key[2])
    expect(keys).toContain('terminal')
    expect(keys).not.toContain('browser')
  })
})
