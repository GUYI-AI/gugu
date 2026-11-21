// @vitest-environment jsdom
import { notifyManager } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A write of this window holds its key against its own broadcast (that broadcast may carry an older value). What another
 * window changed meanwhile is in a broadcast dropped too: every write reads its key again when it settles (I4), the
 * 「不再询问」 of a confirmation as much as a settings row.
 */
const ipc = vi.hoisted(() => {
  const listeners = new Set<(data: { key: string }) => void>()
  const stored: Record<string, unknown> = {}
  let answer: (() => void) | null = null
  return {
    listeners,
    stored,
    getWithMeta: vi.fn(async (key: string) => ({ value: stored[key], defaults: {}, overrides: {} })),
    getAll: vi.fn(async () => Object.fromEntries(Object.entries(stored).map(([key, value]) => [key, { value, defaults: {}, overrides: {} }]))),
    // Main stores the value at once; its answer reaches the window when `answer()` is called.
    update: vi.fn((key: string, value: unknown) => { stored[key] = value; return new Promise<void>((resolve) => { answer = resolve }) }),
    answer: () => answer?.(),
  }
})
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { appSettings: { getWithMeta: ipc.getWithMeta, getAll: ipc.getAll, update: ipc.update } },
  rpcOn: () => ({ appSettings: { getWithMeta: ipc.getWithMeta } }),
  events: { on: (_channel: unknown, cb: (data: { key: string }) => void) => { ipc.listeners.add(cb); return () => ipc.listeners.delete(cb) } },
}))
vi.mock('@/lib/errorSummaryReporting', () => ({ reportHandledError: vi.fn() }))
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: vi.fn() }))

type Client = typeof import('../../../../apps/desktop/src/session/renderer/features/settings/app-settings-client')
let client: Client
const broadcast = (key: string) => { for (const listener of ipc.listeners) listener({ key }) }

beforeEach(async () => {
  notifyManager.setScheduler((callback) => { callback() })
  localStorage.clear()
  vi.resetModules()
  ipc.listeners.clear()
  ipc.stored.interface = { confirmBeforeArchive: true, hideContextBar: false }
  client = await import('../../../../apps/desktop/src/session/renderer/features/settings/app-settings-client')
  await client.prefetchAllAppSettings()
})
afterEach(async () => { (await import('../../../../apps/desktop/src/lib/replica')).queryClient.clear() })

describe('「不再询问」 written from a confirmation', () => {
  it('reads `interface` again once written: another window\'s change heard while it was on its way is not lost', async () => {
    const { stopAsking } = await import('../../../../apps/desktop/src/session/renderer/features/settings/interface-confirm-preference')
    stopAsking('confirmBeforeArchive', { logTag: 'test', title: 't', description: 'd' })
    expect(client.getAppSettingValueSnapshot('interface')).toMatchObject({ confirmBeforeArchive: false })
    // Main stored it; before its answer reaches this window another window turns on another field, and that broadcast is
    // held off (this window's write is still on its way).
    ipc.stored.interface = { ...(ipc.stored.interface as object), hideContextBar: true }
    broadcast('interface')
    ipc.answer()
    await vi.waitFor(() => expect(client.getAppSettingValueSnapshot('interface')).toEqual({ confirmBeforeArchive: false, hideContextBar: true }))
  })
})
