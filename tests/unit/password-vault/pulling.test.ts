import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVaultPulling } from '../../../apps/desktop/electron/password-vault/pulling'
import type { VaultSync } from '../../../apps/desktop/electron/password-vault/sync'

afterEach(() => vi.useRealTimers())
function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(100_000)
  const sync: Pick<VaultSync, 'view' | 'poll' | 'refresh' | 'challenge' | 'dispose'> = {
    view: vi.fn(() => ({ state: 'off' as const })), poll: vi.fn(async () => false),
    refresh: vi.fn(async () => ({ state: 'off' as const })), challenge: vi.fn(async () => ({ state: 'off' as const })),
    dispose: vi.fn(),
  }
  const controller = new AbortController()
  const pull = createVaultPulling(sync, { presence: () => 'active', notify: vi.fn() }, controller.signal)
  return { sync, controller, pull }
}
describe('actual vault pulling timer exit proof', () => {
  it('now and soon cannot replace an admitted refresh with an already-completed empty run', async () => {
    const f = fixture(), held = Promise.withResolvers<Awaited<ReturnType<VaultSync['refresh']>>>()
    vi.mocked(f.sync.refresh).mockReturnValueOnce(held.promise)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.sync.refresh).toHaveBeenCalledTimes(1)
    f.pull.now(); f.pull.soon(); await vi.advanceTimersByTimeAsync(0)
    let stopped = false
    f.controller.abort(); const stopping = f.pull.stop().then(() => { stopped = true })
    await vi.advanceTimersByTimeAsync(0); expect(stopped).toBe(false)
    held.resolve({ state: 'off' }); await stopping
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.sync.refresh).toHaveBeenCalledTimes(1)
    expect(stopped).toBe(true)
  })
  it('also preserves the in-flight cheap poll and never reschedules it after stop', async () => {
    const f = fixture(), held = Promise.withResolvers<boolean>()
    await vi.advanceTimersByTimeAsync(0)
    vi.mocked(f.sync.poll).mockReturnValueOnce(held.promise)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(f.sync.poll).toHaveBeenCalledTimes(1)
    f.pull.now(); await vi.advanceTimersByTimeAsync(0)
    let stopped = false
    const stopping = f.pull.stop().then(() => { stopped = true })
    await vi.advanceTimersByTimeAsync(0); expect(stopped).toBe(false)
    held.resolve(false); await stopping
    f.pull.now(); await vi.advanceTimersByTimeAsync(10_000)
    expect(f.sync.poll).toHaveBeenCalledTimes(1)
    expect(f.sync.refresh).toHaveBeenCalledTimes(1)
  })
})
