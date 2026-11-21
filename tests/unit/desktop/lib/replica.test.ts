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

  it('reread on an entry nobody shows answers a read begun after it, not the one already on its way', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    let calls = 0
    let answerFirst: (value: string) => void = () => {}
    const model = rm.replica({
      name: 'test-reread-unshown', scope: 'account', fresh: Infinity,
      read: () => { calls += 1; return calls === 1 ? new Promise<string>((resolve) => { answerFirst = resolve }) : Promise.resolve('after') },
    })
    const first = model.fetch()
    // Answered without waiting for the read on its way; that read, landing later, does not overwrite it.
    await expect(model.reread()).resolves.toBe('after')
    expect(model.peek()).toMatchObject({ state: 'value', value: 'after' })
    answerFirst('before')
    await expect(first).resolves.toBe('after')
    expect(model.peek()).toMatchObject({ state: 'value', value: 'after' })
    expect(calls).toBe(2)
  })

  it('a read that never leaves this device reads while the browser is offline; others wait for the network', async () => {
    const { onlineManager } = await import('@tanstack/react-query')
    rm.followRendererSession('SIGNED_IN', 'alice')
    onlineManager.setOnline(false)
    try {
      const local = rm.replica({ name: 'test-offline-local', scope: 'account', networkMode: 'always', read: async () => 'here' })
      const remote = rm.replica({ name: 'test-offline-remote', scope: 'account', read: async () => 'there' })
      // Neither is awaited: a read that waits for the network never settles while offline.
      void local.prefetch()
      void remote.prefetch()
      for (let i = 0; i < 5; i += 1) await Promise.resolve()
      expect(local.peek()).toMatchObject({ state: 'value', value: 'here' })
      expect(remote.peek()).toEqual({ state: 'unknown' })
    } finally {
      onlineManager.setOnline(true)
    }
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
    // Judged once the defining module has run (a microtask), before anything renders.
    await Promise.resolve()
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

describe('readings over time: intervals, retries, followers and resets', () => {
  const entriesOf = (owner: string, name: string) => Object.values(JSON.parse(snapshotOf(owner) ?? '{}') as Record<string, { key: unknown[]; value: unknown }>).filter((e) => e.key[0] === name)
  // Time is the fake clock's: ❌ wall-clock sleeps to order writes or count polls.
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }) })
  afterEach(() => { vi.useRealTimers() })
  const tick = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms) }

  it('reads again at an interval the shown value decides, and stops when it says false', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    let n = 0
    const model = rm.replica({ name: 'test-poll', scope: 'account', read: async () => ++n, refreshEvery: (value) => (value !== undefined && value < 3 ? 1_000 : false) })
    function Probe() { rm.useReplica(model, []); return null }
    const harness = createReactHarness()
    await harness.render(createElement(Probe))
    await tick(10_000)
    expect(n).toBe(3)
    harness.cleanup()
  })

  it('a failed refresh being retried is not said until its retries are spent; the value stays', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    let fail = false
    const model = rm.replica({ name: 'test-retrying', scope: 'account', read: async () => { if (fail) throw new Error('offline'); return 1 }, retry: 3, retryDelay: () => 60_000 })
    await model.prefetch()
    fail = true
    void model.refresh(); void model.prefetch()
    await tick(1)
    expect(model.peek()).toMatchObject({ state: 'value', value: 1, error: null })
    await rm.queryClient.cancelQueries()
  })

  it('subscribe hears the one entry\'s changes and no other', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    const model = rm.replica({ name: 'test-sub', scope: 'account', read: async (_owner: string, id: string) => id })
    const heard: string[] = []
    const off = model.subscribe(['a'], () => { heard.push('a') })
    await model.prefetch('b')
    expect(heard).toEqual([])
    await model.prefetch('a')
    expect(heard.length).toBeGreaterThan(0)
    off()
    const before = heard.length
    model.set(['a'], 'x')
    expect(heard.length).toBe(before)
  })

  it('subscribe with an argument left out hears every matching entry, with its arguments and reading', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    const model = rm.replica({ name: 'test-sub-all', scope: 'account', read: async (_owner: string, chat: string, topic: string) => `${chat}/${topic}` })
    const heard: string[] = []
    const off = model.subscribe(['c1', undefined], (entry) => { if (entry.reading.state === 'value') heard.push(entry.args.join('/')) })
    await model.prefetch('c1', 't1'); await model.prefetch('c2', 't1'); await model.prefetch('c1', 't2')
    off()
    expect([...new Set(heard)]).toEqual(['c1/t1', 'c1/t2'])
    expect(model.entries('c1').map((entry) => entry.args.join('/')).sort()).toEqual(['c1/t1', 'c1/t2'])
  })

  it('isFetching and reset: a read on its way is seen; a reset drops the value and reads again', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    let release: (value: string) => void = () => {}
    let n = 0
    const model = rm.replica({ name: 'test-reset', scope: 'account', read: () => (++n === 1 ? Promise.resolve('first') : new Promise<string>((resolve) => { release = resolve })) })
    await model.prefetch()
    expect(model.isFetching()).toBe(false)
    function Probe() { rm.useReplica(model, []); return null }
    const harness = createReactHarness()
    await harness.render(createElement(Probe))
    const reset = model.reset()
    await tick(1)
    expect(model.peek()).toEqual({ state: 'unknown' })
    expect(model.isFetching()).toBe(true)
    release('second'); await reset
    expect(model.peek()).toMatchObject({ state: 'value', value: 'second' })
    harness.cleanup()
  })

  it('an entry restored from the snapshot is read again when shown, however long `fresh` is (I5)', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    let n = 0
    const define = () => rm.replica({ name: 'test-i5', scope: 'account', read: async () => ++n, fresh: Infinity, persist: { maxBytes: 256, maxEntries: 1 } })
    await define().prefetch()
    rm = await freshStart()
    const model = define()
    expect(model.peek()).toMatchObject({ state: 'value', value: 1 })
    rm.followRendererSession('SIGNED_IN', 'alice')
    function Probe() { rm.useReplica(model, []); return null }
    const harness = createReactHarness()
    await harness.render(createElement(Probe))
    await tick(1)
    expect(n).toBe(2)
    harness.cleanup()
  })

  it('a follower of a model hears the entries restored for the account that signs in', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    const define = () => rm.replica({ name: 'test-switch', scope: 'account', read: async () => 'read', persist: { maxBytes: 256, maxEntries: 1 } })
    define().set([], 'alice kept')
    // A start where the session is published after the models are defined (no account pointer to restore from at load).
    localStorage.removeItem('gugu.readModel.v1.account')
    rm = await freshStart()
    const model = define()
    const heard: unknown[] = []
    model.subscribe([], (entry) => { heard.push(entry.reading.state === 'value' ? entry.reading.value : entry.reading.state) })
    rm.followRendererSession('SIGNED_IN', 'alice')
    expect(heard).toContain('alice kept')
  })

  it('reset drops the kept copy too', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    let fail = false
    const model = rm.replica({ name: 'test-drop', scope: 'account', read: async (_owner: string, id: string) => { if (fail) throw new Error('down'); return id }, persist: { maxBytes: 256, maxEntries: 4 } })
    await model.prefetch('b')
    fail = true
    await model.reset('b')
    expect(entriesOf('alice', 'test-drop')).toEqual([])
  })
})


describe('core batch: device reads and change feeds', () => {
  it('a device model reads while the browser says it is offline (its read goes to this device, never waits unknown)', async () => {
    const { onlineManager } = await import('@tanstack/react-query')
    onlineManager.setOnline(false)
    try {
      const host = rm.replica({ name: 'test-device-offline', scope: 'device', read: async () => 'host answer' })
      void host.prefetch()
      for (let i = 0; i < 5; i += 1) await Promise.resolve()
      expect(host.peek()).toMatchObject({ state: 'value', value: 'host answer' })
    } finally {
      onlineManager.setOnline(true)
    }
  })

  it('a change feed runs while a surface shows the group, once per group, and stops with the last surface', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    const log: string[] = []
    const model = rm.replica({
      name: 'test-watch', scope: 'account', fresh: Infinity,
      read: async (_owner: string, chat: string, topic: string) => `${chat}/${topic}`,
      watch: { group: (chat) => chat, start: (owner, chat) => { log.push(`start ${owner} ${chat}`); return () => { log.push(`stop ${owner} ${chat}`) } } },
    })
    function Probe({ chat, topic }: { chat: string; topic: string }) { rm.useReplica(model, [chat, topic]); return null }
    const harness = createReactHarness()
    const shown = (rows: [string, string][]) => harness.render(createElement('div', null,
      ...rows.map(([chat, topic]) => createElement(Probe, { key: `${chat}/${topic}`, chat, topic }))))
    await shown([['c1', 't1'], ['c1', 't2'], ['c2', 't1']])
    expect(log).toEqual(['start alice c1', 'start alice c2'])
    await shown([['c1', 't2']])
    expect(log).toEqual(['start alice c1', 'start alice c2', 'stop alice c2'])
    await shown([])
    expect(log).toEqual(['start alice c1', 'start alice c2', 'stop alice c2', 'stop alice c1'])
    harness.cleanup({ keepReads: true })
  })

  it('a feed starting over entries that already hold a value reads them again (what changed while nobody listened)', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    let version = 1
    const reads = vi.fn(async () => version)
    const model = rm.replica({ name: 'test-watch-reread', scope: 'account', fresh: Infinity, read: reads, watch: { start: () => () => undefined } })
    await model.prefetch()
    version = 2
    function Probe() { rm.useReplica(model, []); return null }
    const harness = createReactHarness()
    await harness.render(createElement(Probe))
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    expect(reads).toHaveBeenCalledTimes(2)
    expect(model.peek()).toMatchObject({ state: 'value', value: 2 })
    harness.cleanup({ keepReads: true })
  })

  it('a model with no push (fresh 0) is read again by a surface that opens while another surface keeps showing it', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    const reads = vi.fn(async () => 'v')
    const model = rm.replica({ name: 'test-open-reads', scope: 'account', read: reads })
    function Probe() { rm.useReplica(model, []); return null }
    const harness = createReactHarness()
    const settle = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve() }
    await harness.render(createElement('div', null, createElement(Probe, { key: 'resident' }))); await settle()
    expect(reads).toHaveBeenCalledTimes(1)
    await harness.render(createElement('div', null, createElement(Probe, { key: 'resident' }), createElement(Probe, { key: 'opened' }))); await settle()
    expect(reads).toHaveBeenCalledTimes(2)
    harness.cleanup({ keepReads: true })
  })

  it('a model kept current by a push (fresh: Infinity) with refreshOnFocus reads again when the window comes back', async () => {
    const { focusManager } = await import('@tanstack/react-query')
    rm.followRendererSession('SIGNED_IN', 'alice')
    const reads = vi.fn(async () => 'v')
    const model = rm.replica({ name: 'test-focus-push', scope: 'account', fresh: Infinity, refreshOnFocus: true, read: reads })
    function Probe() { rm.useReplica(model, []); return null }
    const harness = createReactHarness()
    const settle = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve() }
    await harness.render(createElement(Probe)); await settle()
    expect(reads).toHaveBeenCalledTimes(1)
    focusManager.setFocused(false)
    focusManager.setFocused(true); await settle()
    expect(reads).toHaveBeenCalledTimes(2)
    focusManager.setFocused(undefined)
    harness.cleanup({ keepReads: true })
  })

  it("the previous account's feed stops when the account changes, ❌ kept until the surface goes", async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    const log: string[] = []
    const model = rm.replica({ name: 'test-watch-account', scope: 'account', fresh: Infinity, read: async (owner) => owner,
      watch: { start: (owner) => { log.push(`start ${owner}`); return () => { log.push(`stop ${owner}`) } } } })
    function Probe() { rm.useReplica(model, []); return null }
    const harness = createReactHarness()
    await harness.render(createElement(Probe))
    const { act } = await import('react')
    await act(async () => { rm.followRendererSession('SIGNED_OUT', null); rm.followRendererSession('SIGNED_IN', 'bob') })
    expect(log).toEqual(['start alice', 'stop alice', 'start bob'])
    harness.cleanup({ keepReads: true })
  })
})

describe('seeded and restored values are read again', () => {
  it('a local first value of a push-fed model (fresh: Infinity) is replaced by a real read', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    const reads = vi.fn(async () => 'read')
    const model = rm.replica({ name: 'test-local-infinity', scope: 'account', fresh: Infinity, read: reads, local: () => 'local copy' })
    function Probe() { rm.useReplica(model, []); return null }
    const harness = createReactHarness()
    await harness.render(createElement(Probe))
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    expect(reads).toHaveBeenCalled()
    expect(model.peek()).toMatchObject({ state: 'value', value: 'read' })
    harness.cleanup({ keepReads: true })
  })

  it('a restored entry patched by a write (an updater) is still read again by the next surface', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    const define = (read: () => Promise<string[]>) => rm.replica({ name: 'test-restored-patch', scope: 'account', fresh: Infinity, read, persist: { maxBytes: 256, maxEntries: 1 } })
    await define(async () => ['a']).prefetch()
    rm = await freshStart()
    rm.followRendererSession('SIGNED_IN', 'alice')
    const reads = vi.fn(async () => ['a', 'b', 'server'])
    const model = define(reads)
    model.set([], (old) => [...(old ?? []), 'b'])
    function Probe() { rm.useReplica(model, []); return null }
    const harness = createReactHarness()
    await harness.render(createElement(Probe))
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    expect(reads).toHaveBeenCalledTimes(1)
    harness.cleanup({ keepReads: true })
  })
})

describe('a failed read being read again', () => {
  it('stays an error until a read answers (❌ unknown while the next read is on its way)', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    let answer: ((value: string) => void) | null = null
    let fail = true
    const model = rm.replica({ name: 'test-failed-again', scope: 'account', read: () => fail ? Promise.reject(new Error('down')) : new Promise<string>((resolve) => { answer = resolve }) })
    await model.prefetch()
    expect(model.peek()).toMatchObject({ state: 'error' })
    fail = false
    void model.prefetch()
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    expect(model.isFetching()).toBe(true)
    expect(model.peek()).toMatchObject({ state: 'error', error: { message: 'down' } })
    answer!('up')
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    expect(model.peek()).toMatchObject({ state: 'value', value: 'up' })
  })
})


/** A read the test answers by hand: `answer(i, value)` / `fail(i, error)` settle the i-th call. */
function heldReads<V>() {
  const calls: { resolve: (value: V) => void; reject: (error: Error) => void }[] = []
  const read = () => new Promise<V>((resolve, reject) => { calls.push({ resolve, reject }) })
  const settle = async (step: () => void) => { step(); await new Promise((done) => setTimeout(done, 0)) }
  return {
    read, calls,
    answer: (index: number, value: V) => settle(() => calls[index]!.resolve(value)),
    fail: (index: number, error: Error) => settle(() => calls[index]!.reject(error)),
  }
}

describe('a write over a read on its way (@@@write-over-read)', () => {
  it('a read that began before a write does not overwrite it: the written value stays', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    const reads = heldReads<string>()
    const model = rm.replica({ name: 'test-wor-old', scope: 'account', read: reads.read })
    const first = model.prefetch()
    model.at().set('written')
    await reads.answer(0, 'read before the write')
    await first
    expect(model.peek()).toMatchObject({ state: 'value', value: 'written' })
    expect(reads.calls).toHaveLength(1)
  })

  it('a read that begins after a write lands as usual', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    const reads = heldReads<string>()
    const model = rm.replica({ name: 'test-wor-after', scope: 'account', read: reads.read })
    model.set([], 'written')
    const read = model.fetch()
    await reads.answer(0, 'read after')
    expect(await read).toBe('read after')
    expect(model.peek()).toMatchObject({ state: 'value', value: 'read after' })
    expect(reads.calls).toHaveLength(1)
  })

  it('a read that began before a write and fails does not turn the written value into an error', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    const reads = heldReads<string>()
    const model = rm.replica({ name: 'test-wor-fail', scope: 'account', read: reads.read })
    const first = model.prefetch()
    model.at().set('written')
    await reads.fail(0, new Error('offline'))
    await first
    expect(model.peek()).toMatchObject({ state: 'value', value: 'written', error: null })
  })

  it('a write bound to an account before a switch lands in that account, ❌ the next one', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    const reads = heldReads<string>()
    const model = rm.replica({ name: 'test-wor-account', scope: 'account', read: reads.read })
    const alices = model.at()
    rm.followRendererSession('SIGNED_IN', 'bob')
    alices.set('alice wrote')
    expect(model.peek()).toEqual({ state: 'unknown' })
  })
})

describe('a reading carries its own retry; models read again by tag', () => {
  it('retry reads the reading\'s own entry again, and is one function per entry', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    let n = 0
    const model = rm.replica({ name: 'test-retry', scope: 'account', fresh: Infinity, read: async (_owner, id: string) => `${id}:${++n}` })
    await model.prefetch('a'); await model.prefetch('b')
    const a = model.peek('a')
    if (a.state !== 'value') throw new Error('not read')
    expect(a.retry).toBe((model.peek('a') as { retry?: unknown }).retry)
    await a.retry!()
    // Read again where shown; nobody shows it here, so it is stale and the next read takes it.
    await model.fetch('a'); await model.fetch('b')
    expect(model.peek('a')).toMatchObject({ value: 'a:3' })
    expect(model.peek('b')).toMatchObject({ value: 'b:2' })
  })

  it('refreshTag reads every model of the tag again (arguments left out match any), and no other', async () => {
    rm.followRendererSession('SIGNED_IN', 'alice')
    const count = { one: 0, two: 0, other: 0 }
    const one = rm.replica({ name: 'test-tag-one', scope: 'account', fresh: Infinity, tags: ['t'], read: async (_owner, host: string) => `${host}:${++count.one}` })
    const two = rm.replica({ name: 'test-tag-two', scope: 'device', fresh: Infinity, tags: ['t'], read: async (_owner, host: string, id: string) => `${host}/${id}:${++count.two}` })
    const other = rm.replica({ name: 'test-tag-other', scope: 'account', fresh: Infinity, read: async () => ++count.other })
    await one.prefetch('h1'); await one.prefetch('h2'); await two.prefetch('h1', 'x'); await other.prefetch()
    await rm.refreshTag('t', 'h1')
    await one.fetch('h1'); await one.fetch('h2'); await two.fetch('h1', 'x'); await other.fetch()
    expect(one.peek('h1')).toMatchObject({ value: 'h1:3' })
    expect(one.peek('h2')).toMatchObject({ value: 'h2:2' })
    expect(two.peek('h1', 'x')).toMatchObject({ value: 'h1/x:2' })
    expect(count.other).toBe(1)
  })
})
