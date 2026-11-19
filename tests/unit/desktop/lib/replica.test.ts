// @vitest-environment jsdom
import { notifyManager } from '@tanstack/react-query'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'

/**
 * The replica's contract (lib/replica.ts): a reading is unknown / value / error, never a default; the cache and the
 * snapshot across restarts belong to the signed-in account and leave with it; the snapshot holds what was read, nothing
 * of the session.
 */
type Module = typeof import('../../../../apps/desktop/src/lib/replica')
let rm: Module

async function freshStart(): Promise<Module> {
  // A new renderer process: module state gone, localStorage kept (what a restart keeps).
  vi.resetModules()
  return import('../../../../apps/desktop/src/lib/replica')
}

const snapshotOf = (account: string) => localStorage.getItem(`gugu.readModel.v1:${account}`)
const LIMITS = { maxBytes: 4096, maxEntries: 8 }

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
    const name = rm.replica({ name: 'test-name', scope: 'account', read: () => new Promise<string>((resolve) => { answer = resolve }) })
    expect(name.peek()).toEqual({ state: 'unknown' })
    const pending = name.prefetch()
    expect(name.peek()).toEqual({ state: 'unknown' })
    answer('Alice'); await pending
    expect(name.peek()).toMatchObject({ state: 'value', value: 'Alice', error: null })

    const broken = rm.replica({ name: 'test-broken', scope: 'account', read: async () => { throw new Error('denied') } })
    await broken.prefetch()
    expect(broken.peek()).toMatchObject({ state: 'error', error: { message: 'denied' } })
  })

  it('keeps the last value and says the refresh failed (the surface decides what a failed refresh means)', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    let fail = false
    const model = rm.replica({ name: 'test-refresh', scope: 'account', read: async () => { if (fail) throw new Error('offline'); return 1 } })
    await model.prefetch()
    fail = true
    await model.prefetch()
    expect(model.peek()).toMatchObject({ state: 'value', value: 1, error: { message: 'offline' } })
  })

  it('draws through useReplica: the first frame of a surface opened again already has the value', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    const reads = vi.fn(async () => 'kept')
    const model = rm.replica({ name: 'test-hook', scope: 'account', read: reads, fresh: 60_000 })
    await model.prefetch()
    const seen: string[] = []
    function Probe() {
      const reading = rm.useReplica(model, [])
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
  const persisted = () => rm.replica({ name: 'test-persisted', scope: 'account', read: async (owner) => ({ label: `${owner}'s` }), persist: LIMITS })

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
    await rm.replica({ name: 'test-early', scope: 'account', read: async () => 1, persist: LIMITS }).prefetch()
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
    rm.replica({ name: 'test-restored', scope: 'account', read: async () => 'read', persist: LIMITS }).set([], 'kept')
    rm = await freshStart()
    vi.useFakeTimers()
    try {
      const restored = rm.replica({ name: 'test-restored', scope: 'account', read: async () => 'read', persist: LIMITS })
      const written = rm.replica({ name: 'test-written', scope: 'account', read: async () => 'read' })
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
    const name = rm.replica({ name: 'test-bound', scope: 'account', read: async () => 'read' })
    const alices = name.at()
    rm.followRendererSession('SIGNED_IN', 'bob')
    alices.set('alice saved')
    expect(name.peek()).toEqual({ state: 'unknown' })
  })

  it('a refresh that leaves an argument out matches any value there, without shifting the ones after it', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    const model = rm.replica({ name: 'test-args', scope: 'device', read: async (_d: string, machine: string | null, provider: string) => `${machine}:${provider}` })
    await model.prefetch('mac', 'codex'); await model.prefetch('mac', 'claude'); await model.prefetch(null, 'codex')
    await model.refresh(undefined, 'codex')
    const invalidated = (machine: string | null, provider: string) => rm.queryClient.getQueryState(model.key(machine, provider)!)?.isInvalidated
    expect([invalidated('mac', 'codex'), invalidated(null, 'codex'), invalidated('mac', 'claude')]).toEqual([true, true, false])
  })
})

describe('snapshot limits (@@@client-state-model, persistence)', () => {
  const entriesOf = (account: string, name: string) => Object.values(JSON.parse(snapshotOf(account) ?? '{}') as Record<string, { key: unknown[] }>).filter((e) => e.key[0] === name)
  const counters = async () => (await import('../../../../apps/desktop/src/lib/perfCounters')).readPerfCounters()

  it('an entry over its maxBytes is not kept (and neither is its older copy), said and counted', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    let size = 10
    const model = rm.replica({ name: 'test-big', scope: 'account', read: async () => 'x'.repeat(size), persist: { maxBytes: 200, maxEntries: 1 } })
    await model.prefetch()
    expect(entriesOf('alice', 'test-big')).toHaveLength(1)
    const before = (await counters()).snapshotRefusals
    size = 1000
    await model.refresh(); await model.prefetch()
    expect(entriesOf('alice', 'test-big')).toHaveLength(0)
    expect((await counters()).snapshotRefusals).toBe(before + 1)
    expect(errors.mock.calls.some((call) => JSON.stringify(call).includes('test-big'))).toBe(true)
    errors.mockRestore()
  })

  it('keeps only the newest maxEntries keys of a model', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    const model = rm.replica({ name: 'test-days', scope: 'account', read: async (_owner: string, day: string) => day, persist: { maxBytes: 4096, maxEntries: 2 } })
    for (const day of ['d1', 'd2', 'd3']) { await model.prefetch(day); await new Promise((resolve) => setTimeout(resolve, 2)) }
    expect(entriesOf('alice', 'test-days').map((e) => e.key[2]).sort()).toEqual(['d2', 'd3'])
  })

  // An upgrade: the older build kept entries this build's models no longer admit (persist dropped, a limit shrunk).
  it('restores only what the model as defined now admits, and drops the rest from the snapshot', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    const kept = { maxBytes: 4096, maxEntries: 4 }
    for (const name of ['test-unpersisted', 'test-shrunk', 'test-early', 'test-same']) {
      await rm.replica({ name, scope: 'account', read: async () => 'x'.repeat(300), persist: kept }).prefetch()
    }
    expect(['test-unpersisted', 'test-shrunk', 'test-early', 'test-same'].map((name) => entriesOf('alice', name).length)).toEqual([1, 1, 1, 1])

    rm = await freshStart()
    // Registered before the account's block is restored: the restore judges it.
    const early = rm.replica({ name: 'test-early', scope: 'account', read: async () => 'new' })
    rm.followRendererSession('SIGNED_IN', 'alice')
    // Registered after: judged as it registers.
    const unpersisted = rm.replica({ name: 'test-unpersisted', scope: 'account', read: async () => 'new' })
    const shrunk = rm.replica({ name: 'test-shrunk', scope: 'account', read: async () => 'new', persist: { maxBytes: 100, maxEntries: 1 } })
    const same = rm.replica({ name: 'test-same', scope: 'account', read: async () => 'new', persist: kept })
    expect([early.peek().state, unpersisted.peek().state, shrunk.peek().state, same.peek().state]).toEqual(['unknown', 'unknown', 'unknown', 'value'])
    expect(['test-unpersisted', 'test-shrunk', 'test-early', 'test-same'].map((name) => entriesOf('alice', name).length)).toEqual([0, 0, 0, 1])
  })

  it('a block the storage refuses is said and counted, ❌ swallowed; the value read stays', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError') })
    const before = (await counters()).snapshotRefusals
    const model = rm.replica({ name: 'test-quota', scope: 'account', read: async () => 'v', persist: LIMITS })
    await model.prefetch()
    setItem.mockRestore()
    expect(model.peek()).toMatchObject({ state: 'value', value: 'v' })
    expect((await counters()).snapshotRefusals).toBe(before + 1)
    expect(errors.mock.calls.some((call) => JSON.stringify(call).includes('test-quota'))).toBe(true)
    errors.mockRestore()
  })
})
