import type { Session } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IOSOwnerPublication, type IOSOwnerSessionSource } from '../../../../apps/desktop/src/mobile/ios-runtime/iosOwnerPublication'
import type { IOSOwnerBinding, IOSOwnerClient } from '../../../../apps/desktop/src/mobile/ios-runtime/iosOwnerClient'

const A = '10000000-0000-0000-0000-000000000001', B = '20000000-0000-0000-0000-000000000002'
const install = '30000000-0000-0000-0000-000000000003'
const NOW = 1_800_000_000_000
const binding = (ownerId = A): IOSOwnerBinding => ({ ownerId, installationId: install, deviceId: `phone-${install}-${ownerId}` })
function session(ownerId = A, access = 'synthetic-access-a', expires = NOW + 60_000): Session {
  return { user: { id: ownerId }, access_token: access, refresh_token: 'synthetic-refresh-never-forward', expires_at: expires / 1_000 } as Session
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const flush = async () => { for (let i = 0; i < 18; ++i) await Promise.resolve() }
const instances: IOSOwnerPublication[] = []
function harness(initial: ReturnType<IOSOwnerSessionSource['getSnapshot']> = { status: 'authenticated', session: session() }) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  const source: IOSOwnerSessionSource = { getSnapshot: () => snapshot,
    subscribe: vi.fn(listener => { listeners.add(listener); return () => listeners.delete(listener) }), captureAuthHandoff: vi.fn(async () => {}) }
  const client: IOSOwnerClient = { available: vi.fn(() => true), publish: vi.fn(async ({ ownerId }) => binding(ownerId)),
    getBinding: vi.fn(async ownerId => binding(ownerId)), retire: vi.fn(async () => {}) }
  let foreground!: () => void, observerFailed!: (error: unknown) => void
  const unsubscribe = vi.fn()
  const publication = new IOSOwnerPublication(source, client, (changed, failed) => { foreground = changed; observerFailed = failed; return unsubscribe })
  instances.push(publication)
  return { source, client, publication, unsubscribe, foreground: () => foreground(), observerFailed: (error: unknown) => observerFailed(error),
    change: (next: typeof initial) => { snapshot = next; listeners.forEach(listener => listener()) } }
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
afterEach(async () => { for (const instance of instances.splice(0)) await instance.stop().catch(() => undefined); vi.useRealTimers() })

describe('iOS owner publication lifetime', () => {
  it('stays unavailable when the native plugin is absent without publishing or reading binding', async () => {
    const h = harness(); vi.mocked(h.client.available).mockReturnValue(false)
    h.publication.start(); await flush()
    expect(h.publication.getSnapshot().status).toBe('unavailable')
    expect(h.client.publish).not.toHaveBeenCalled(); expect(h.client.getBinding).not.toHaveBeenCalled()
  })

  it.each([
    { status: 'boot-restoring' as const, session: session() }, { status: 'anonymous' as const, session: null },
    { status: 'expired' as const, session: session() }, { status: 'degraded' as const, session: session(A, 'expired', NOW) },
    { status: 'authenticated' as const, session: { ...session(), expires_at: undefined } },
    { status: 'authenticated' as const, session: session('malformed-owner') },
  ])('does not publish an undecided, retired or expired snapshot %#', async snapshot => {
    const h = harness(snapshot); h.publication.start(); await flush()
    expect(h.publication.getSnapshot()).toMatchObject({ status: 'waiting', binding: null })
    expect(h.client.publish).not.toHaveBeenCalled()
  })

  it('lets a degraded unexpired session attempt native verification without a refresh operation', async () => {
    const h = harness({ status: 'degraded', session: session() }); h.publication.start(); await flush()
    expect(h.publication.getSnapshot()).toMatchObject({ status: 'ready', binding: binding() })
    expect(h.client.publish).toHaveBeenCalledExactlyOnceWith({ ownerId: A, accessToken: 'synthetic-access-a' })
    expect(h.client.getBinding).toHaveBeenCalledExactlyOnceWith(A)
    expect(JSON.stringify(h.publication.getSnapshot())).not.toMatch(/synthetic|accessToken|refresh/)
  })

  it('waits for coordinator persistence/handoff before forwarding only the current short token', async () => {
    const gate = deferred<void>(), h = harness()
    vi.mocked(h.source.captureAuthHandoff).mockReturnValue(gate.promise)
    h.publication.start(); await flush()
    expect(h.client.publish).not.toHaveBeenCalled()
    h.change({ status: 'authenticated', session: session(B, 'synthetic-access-b') })
    gate.resolve(); await flush()
    expect(h.client.publish).toHaveBeenCalledExactlyOnceWith({ ownerId: B, accessToken: 'synthetic-access-b' })
    expect(h.publication.getSnapshot()).toMatchObject({ status: 'ready', binding: binding(B) })
  })

  it('withdraws the old identity during token refresh and drops an old successful publication', async () => {
    const old = deferred<IOSOwnerBinding>(), h = harness()
    vi.mocked(h.client.publish).mockReturnValueOnce(old.promise)
    h.publication.start(); await flush()
    h.change({ status: 'authenticated', session: session(A, 'synthetic-rotated') }); await flush()
    expect(h.publication.getSnapshot()).toMatchObject({ status: 'ready', binding: binding() })
    old.resolve(binding()); await flush()
    expect(h.client.publish).toHaveBeenCalledTimes(2)
    expect(h.client.getBinding).toHaveBeenCalledOnce()
    expect(h.client.retire).not.toHaveBeenCalled()
  })

  it('does not let an old token publication failure erase a newer verified identity', async () => {
    const old = deferred<IOSOwnerBinding>(), h = harness()
    vi.mocked(h.client.publish).mockReturnValueOnce(old.promise)
    h.publication.start(); await flush()
    h.change({ status: 'authenticated', session: session(A, 'synthetic-rotated') }); await flush()
    old.reject({ code: 'stale_context', message: 'old request failed' }); await flush()
    expect(h.publication.getSnapshot()).toMatchObject({ status: 'ready', binding: binding() })
  })

  it('relies on the committed Keychain owner-change barrier and ignores a late old binding read', async () => {
    const old = deferred<IOSOwnerBinding | null>(), h = harness()
    vi.mocked(h.client.getBinding).mockReturnValueOnce(old.promise)
    h.publication.start(); await flush()
    h.change({ status: 'authenticated', session: session(B, 'synthetic-b') }); await flush()
    expect(h.client.retire).not.toHaveBeenCalled()
    expect(h.publication.getSnapshot()).toMatchObject({ status: 'ready', binding: binding(B) })
    old.resolve(binding()); await flush()
    expect(h.publication.getSnapshot()).toMatchObject({ status: 'ready', binding: binding(B) })
  })

  it('retires a still-pending publication on signout and never restores its late result', async () => {
    const old = deferred<IOSOwnerBinding>(), h = harness()
    vi.mocked(h.client.publish).mockReturnValueOnce(old.promise)
    h.publication.start(); await flush()
    h.change({ status: 'anonymous', session: null }); await flush()
    expect(h.client.retire).toHaveBeenCalledExactlyOnceWith(A)
    old.resolve(binding()); await flush()
    expect(h.publication.getSnapshot()).toMatchObject({ status: 'waiting', binding: null })
    expect(h.client.getBinding).not.toHaveBeenCalled()
  })

  it('waits for an auth write admitted during native readback before exposing readiness', async () => {
    const readback = deferred<IOSOwnerBinding | null>(), write = deferred<void>(), h = harness()
    vi.mocked(h.source.captureAuthHandoff).mockResolvedValueOnce(undefined).mockReturnValue(write.promise)
    vi.mocked(h.client.getBinding).mockReturnValueOnce(readback.promise)
    h.publication.start(); await flush()
    readback.resolve(binding()); await flush()
    expect(h.publication.getSnapshot()).toMatchObject({ status: 'publishing', binding: null })
    h.change({ status: 'authenticated', session: session(B, 'synthetic-b') }); await flush()
    write.resolve(); await flush()
    expect(h.publication.getSnapshot()).toMatchObject({ status: 'ready', binding: binding(B) })
  })

  it('keeps same-owner retirement failure fenced until a later retirement succeeds', async () => {
    const h = harness(); h.publication.start(); await flush()
    vi.mocked(h.client.retire).mockRejectedValueOnce(new Error('internal synthetic-access-a detail'))
    h.change({ status: 'anonymous', session: null }); await flush()
    expect(h.publication.getSnapshot()).toMatchObject({ status: 'failed', binding: null, error: { code: 'retirement_failed' } })
    expect(JSON.stringify(h.publication.getSnapshot())).not.toContain('synthetic-access-a')
    expect(h.client.publish).toHaveBeenCalledOnce()
    h.change({ status: 'authenticated', session: session() }); await flush()
    expect(h.client.retire).toHaveBeenCalledTimes(2)
    expect(h.client.publish).toHaveBeenCalledTimes(2)
    expect(h.publication.getSnapshot()).toMatchObject({ status: 'ready', binding: binding() })
  })

  it('still requires native success if an old retirement failed before another owner committed', async () => {
    const h = harness(); h.publication.start(); await flush()
    vi.mocked(h.client.retire).mockRejectedValueOnce({ code: 'stop_failed' })
    h.change({ status: 'anonymous', session: null }); await flush()
    vi.mocked(h.client.publish).mockRejectedValueOnce({ code: 'host_not_ready' })
    h.change({ status: 'authenticated', session: session(B, 'synthetic-b') }); await flush()
    expect(h.publication.getSnapshot()).toMatchObject({ status: 'failed', binding: null })
    expect(h.client.retire).toHaveBeenCalledExactlyOnceWith(A)
    await h.publication.refresh()
    expect(h.publication.getSnapshot()).toMatchObject({ status: 'ready', binding: binding(B) })
  })

  it('waits for the prior stop retirement even when restarting the same owner', async () => {
    const retired = deferred<void>(), h = harness(); h.publication.start(); await flush()
    vi.mocked(h.client.retire).mockReturnValueOnce(retired.promise)
    const stopping = h.publication.stop(); h.publication.start(); await flush()
    expect(h.publication.getSnapshot().status).toBe('retiring')
    expect(h.client.publish).toHaveBeenCalledOnce()
    retired.resolve(); await stopping; await flush()
    expect(h.client.publish).toHaveBeenCalledTimes(2)
    expect(h.publication.getSnapshot()).toMatchObject({ status: 'ready', binding: binding() })
  })

  it('keeps stop failure visible and does not publish on restart until retirement succeeds', async () => {
    const h = harness(); h.publication.start(); await flush()
    vi.mocked(h.client.retire).mockRejectedValueOnce(new Error('stop failed')).mockRejectedValueOnce(new Error('still failed'))
    await expect(h.publication.stop()).rejects.toMatchObject({ code: 'retirement_failed' })
    h.publication.start(); await flush()
    expect(h.publication.getSnapshot()).toMatchObject({ status: 'failed', binding: null })
    expect(h.client.publish).toHaveBeenCalledOnce()
    await h.publication.refresh()
    expect(h.publication.getSnapshot().status).toBe('ready')
  })

  it('withdraws a verified identity and retires at access expiry without asking for refresh', async () => {
    const h = harness(); h.publication.start(); await flush()
    await vi.advanceTimersByTimeAsync(60_001)
    expect(h.publication.getSnapshot()).toMatchObject({ status: 'waiting', binding: null })
    expect(h.client.retire).toHaveBeenCalledExactlyOnceWith(A)
    expect(h.client.publish).toHaveBeenCalledOnce()
  })

  it('also retires at expiry while native publication is still pending', async () => {
    const pending = deferred<IOSOwnerBinding>(), h = harness()
    vi.mocked(h.client.publish).mockReturnValueOnce(pending.promise)
    h.publication.start(); await flush()
    await vi.advanceTimersByTimeAsync(60_001)
    expect(h.client.retire).toHaveBeenCalledExactlyOnceWith(A)
    pending.resolve(binding()); await flush()
    expect(h.publication.getSnapshot()).toMatchObject({ status: 'waiting', binding: null })
  })

  it('does not trust a publication when native readback is unavailable or belongs to another binding', async () => {
    const h = harness(); vi.mocked(h.client.getBinding).mockResolvedValue(null)
    h.publication.start(); await flush()
    expect(h.publication.getSnapshot()).toMatchObject({ status: 'failed', binding: null })
    vi.mocked(h.client.getBinding).mockResolvedValue({ ...binding(), installationId: 'changed-installation' })
    await h.publication.refresh()
    expect(h.publication.getSnapshot()).toMatchObject({ status: 'failed', binding: null })
  })

  it('does not duplicate publication for profile-only changes, but revalidates on foreground', async () => {
    const h = harness(); h.publication.start(); await flush()
    h.change({ status: 'authenticated', session: { ...session(), user: { ...session().user, email: 'changed@example.invalid' } } }); await flush()
    expect(h.client.publish).toHaveBeenCalledOnce()
    h.foreground(); await flush()
    expect(h.client.publish).toHaveBeenCalledTimes(2)
  })

  it('withdraws same-token readiness when coordinator cleanup fails and native reports a retired session', async () => {
    const h = harness(); h.publication.start(); await flush()
    vi.mocked(h.client.publish).mockRejectedValueOnce({ code: 'stale_context', message: 'Stored session is retired' })
    h.change({ status: 'degraded', session: session(), error: new Error('Session storage cleanup failed') })
    expect(h.publication.getSnapshot()).toMatchObject({ status: 'publishing', binding: null })
    await flush()
    expect(h.publication.getSnapshot()).toMatchObject({ status: 'failed', binding: null })
    expect(h.client.publish).toHaveBeenCalledTimes(2)
    h.change({ status: 'degraded', session: session(), error: new Error('Session restored after logout failure') }); await flush()
    expect(h.client.publish).toHaveBeenCalledTimes(3)
    expect(h.publication.getSnapshot()).toMatchObject({ status: 'ready', binding: binding() })
  })

  it('drops pending results after stop or a lifecycle subscription failure', async () => {
    const pending = deferred<IOSOwnerBinding>(), h = harness()
    vi.mocked(h.client.publish).mockReturnValueOnce(pending.promise)
    h.publication.start(); await flush()
    h.observerFailed(new Error('synthetic-access-a internal error'))
    pending.resolve(binding()); await flush()
    expect(h.publication.getSnapshot()).toMatchObject({ status: 'failed', binding: null })
    expect(JSON.stringify(h.publication.getSnapshot())).not.toContain('synthetic-access-a')
    await h.publication.stop()
    h.change({ status: 'authenticated', session: session(B, 'synthetic-b') }); h.foreground(); await flush()
    expect(h.publication.getSnapshot()).toMatchObject({ status: 'stopped', binding: null })
    expect(h.unsubscribe).toHaveBeenCalledOnce()
    expect(h.client.publish).toHaveBeenCalledOnce()
  })
})
