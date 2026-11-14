// @vitest-environment jsdom
import { notifyManager } from '@tanstack/react-query'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'

/**
 * The read model's contract (lib/readModel.ts): a reading is unknown / value / error, never a default; the cache and the
 * snapshot across restarts belong to the signed-in account and leave with it; the snapshot holds what was read, nothing
 * of the session.
 */
type Module = typeof import('../../../../apps/desktop/src/lib/readModel')
let rm: Module

async function freshStart(): Promise<Module> {
  // A new renderer process: module state gone, localStorage kept (what a restart keeps).
  vi.resetModules()
  return import('../../../../apps/desktop/src/lib/readModel')
}

const snapshotOf = (account: string) => localStorage.getItem(`gugu.readModel.v1:${account}`)

beforeEach(async () => {
  notifyManager.setScheduler((callback) => { callback() })
  localStorage.clear()
  rm = await freshStart()
})
afterEach(() => { rm.queryClient.clear() })

describe('readings', () => {
  it('is unknown until read, a value once read, and an error without a value when the first read fails', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    let answer: (value: string) => void = () => {}
    const name = rm.readModel({ name: 'test-name', scope: 'account', read: () => new Promise<string>((resolve) => { answer = resolve }) })
    expect(name.peek()).toEqual({ state: 'unknown' })
    const pending = name.prefetch()
    expect(name.peek()).toEqual({ state: 'unknown' })
    answer('Alice'); await pending
    expect(name.peek()).toMatchObject({ state: 'value', value: 'Alice', error: null })

    const broken = rm.readModel({ name: 'test-broken', scope: 'account', read: async () => { throw new Error('denied') } })
    await broken.prefetch()
    expect(broken.peek()).toMatchObject({ state: 'error', error: { message: 'denied' } })
  })

  it('keeps the last value and says the refresh failed (the surface decides what a failed refresh means)', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    let fail = false
    const model = rm.readModel({ name: 'test-refresh', scope: 'account', read: async () => { if (fail) throw new Error('offline'); return 1 } })
    await model.prefetch()
    fail = true
    await model.prefetch()
    expect(model.peek()).toMatchObject({ state: 'value', value: 1, error: { message: 'offline' } })
  })

  it('draws through useReadModel: the first frame of a surface opened again already has the value', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    const reads = vi.fn(async () => 'kept')
    const model = rm.readModel({ name: 'test-hook', scope: 'account', read: reads, fresh: 60_000 })
    await model.prefetch()
    const seen: string[] = []
    function Probe() {
      const reading = rm.useReadModel(model, [])
      seen.push(reading.state)
      return null
    }
    const harness = createReactHarness()
    await harness.render(createElement(Probe))
    expect(seen[0]).toBe('value')
    expect(reads).toHaveBeenCalledTimes(1)
    harness.cleanup()
  })
})

describe('the account owns the cache and the snapshot', () => {
  const persisted = () => rm.readModel({ name: 'test-persisted', scope: 'account', read: async (owner) => ({ label: `${owner}'s` }), persist: true })

  it('restores the last value synchronously after a restart, for the same account only', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    await persisted().prefetch()
    expect(JSON.parse(snapshotOf('alice')!)).toBeTruthy()

    rm = await freshStart()
    // Before the session is restored: the last account's values are already there, marked stale, not read yet.
    const restored = persisted()
    expect(restored.peek()).toMatchObject({ state: 'value', value: { label: "alice's" } })
  })

  it('a model whose code loads later (a lazy chunk) keeps its snapshot while others write theirs', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    await persisted().prefetch()
    rm = await freshStart()
    // Another model writes before this one's module is evaluated.
    await rm.readModel({ name: 'test-early', scope: 'account', read: async () => 1, persist: true }).prefetch()
    expect(persisted().peek()).toMatchObject({ state: 'value', value: { label: "alice's" } })
  })

  it('a sign-out drops the account from memory and its snapshot from disk', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    const model = persisted()
    await model.prefetch()
    expect(snapshotOf('alice')).not.toBeNull()
    rm.followRendererSession('SIGNED_OUT', null)
    expect(snapshotOf('alice')).toBeNull()
    expect(model.peek()).toEqual({ state: 'unknown' })
    rm = await freshStart()
    expect(persisted().peek()).toEqual({ state: 'unknown' })
  })

  it('another person signing in drops the previous account, and its snapshot never shows for the new one', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    const model = persisted()
    await model.prefetch()
    rm.followRendererSession('SIGNED_IN', 'bob')
    expect(snapshotOf('alice')).toBeNull()
    expect(model.peek()).toEqual({ state: 'unknown' })
  })

  it('a session that is only absent (boot restore, a refresh that cannot reach the network) keeps everything', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    const model = persisted()
    await model.prefetch()
    rm.followRendererSession('TOKEN_REFRESH_FAILED', null)
    expect(model.peek()).toMatchObject({ state: 'value' })
    expect(snapshotOf('alice')).not.toBeNull()
  })

  it('the snapshot holds the values read and nothing of the session', async () => {
    const { publishRendererSession } = await import('../../../../apps/desktop/src/lib/sessionPublication')
    publishRendererSession('SIGNED_IN', {
      access_token: 'eyJhbGciOiJIUzI1NiJ9.access.sig', refresh_token: 'refresh-secret', user: { id: 'alice' },
    } as never)
    await persisted().prefetch()
    const stored = snapshotOf('alice')!
    expect(stored).not.toMatch(/eyJ|refresh-secret|access_token|refresh_token/)
    expect(Object.values(JSON.parse(stored) as Record<string, { value: unknown }>).map((entry) => entry.value)).toEqual([{ label: "alice's" }])
  })
})

describe('acceptance fixes', () => {
  // Acceptance 1.3: entries restored at start or put by a write were collected after react-query's five minutes when no
  // surface watched them, so Settings opened a while after launch drew placeholders again.
  it('an entry restored at start or put by a write outlives five minutes with nobody watching', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    rm.readModel({ name: 'test-restored', scope: 'account', read: async () => 'read', persist: true }).set([], 'kept')
    rm = await freshStart()
    vi.useFakeTimers()
    try {
      const restored = rm.readModel({ name: 'test-restored', scope: 'account', read: async () => 'read', persist: true })
      const written = rm.readModel({ name: 'test-written', scope: 'account', read: async () => 'read' })
      written.set([], 'saved')
      vi.advanceTimersByTime(6 * 60_000)
      expect(restored.peek()).toMatchObject({ state: 'value', value: 'kept' })
      expect(written.peek()).toMatchObject({ state: 'value', value: 'saved' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a value bound before an await does not land in the account signed in after it', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    const name = rm.readModel({ name: 'test-bound', scope: 'account', read: async () => 'read' })
    const alices = name.at()
    rm.followRendererSession('SIGNED_IN', 'bob')
    alices.set('alice saved')
    expect(name.peek()).toEqual({ state: 'unknown' })
  })

  it('a refresh that leaves an argument out matches any value there, without shifting the ones after it', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    const model = rm.readModel({ name: 'test-args', scope: 'device', read: async (_d: string, machine: string | null, provider: string) => `${machine}:${provider}` })
    await model.prefetch('mac', 'codex'); await model.prefetch('mac', 'claude'); await model.prefetch(null, 'codex')
    await model.refresh(undefined, 'codex')
    const invalidated = (machine: string | null, provider: string) => rm.queryClient.getQueryState(model.key(machine, provider)!)?.isInvalidated
    expect([invalidated('mac', 'codex'), invalidated(null, 'codex'), invalidated('mac', 'claude')]).toEqual([true, true, false])
  })
})
