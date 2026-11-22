import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CloudComputerSnapshot } from '@gugu/core/cloud/cloudComputer'

const f = vi.hoisted(() => ({ state: vi.fn(), wake: vi.fn() }))
vi.mock('@/lib/cloudComputerClient', () => ({ rendererCloudComputerClient: () => f }))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ warn() {}, debug() {}, info() {}, error() {} }) }))
const { wakeAndWaitOnline: ensureCloudConnectionReady, readCloudSnapshotNow } = await import('@/lib/cloudComputer')
const { publishRendererSession } = await import('@/lib/sessionPublication')
const signIn = (id: string) => publishRendererSession('SIGNED_IN', { user: { id }, access_token: 't' } as never)
const snap = (state: CloudComputerSnapshot['state']): CloudComputerSnapshot => ({ state, deviceId: 'cloud', since: null, error: null })

beforeEach(async () => {
  vi.clearAllMocks()
  signIn('owner')
  f.state.mockResolvedValue(snap('awake'))
  await readCloudSnapshotNow()
})
afterEach(() => vi.useRealTimers())

it('re-reads the controller after attach failure and resumes despite stale awake presence', async () => {
  vi.useFakeTimers()
  f.state.mockResolvedValue(snap('asleep'))
  f.wake.mockImplementationOnce(async () => { f.state.mockResolvedValue(snap('awake')) })
  const online = vi.fn(async () => true)
  const resumed = ensureCloudConnectionReady('cloud', { isOnline: online })
  await vi.advanceTimersByTimeAsync(2_000)
  await resumed
  expect(f.wake).toHaveBeenCalledOnce()
  expect(online).toHaveBeenCalledWith('cloud')
})

it('refuses an unrelated machine without sending a wake under this account', async () => {
  const before = f.state.mock.calls.length
  await expect(ensureCloudConnectionReady('another-machine', { isOnline: async () => false })).rejects.toThrow('not this account')
  expect(f.state.mock.calls.length - before).toBe(1) // The ownership check.
  expect(f.wake).not.toHaveBeenCalled()
})

it('shares simultaneous connection checks and permits a later retry after completion', async () => {
  let answer!: (value: CloudComputerSnapshot) => void
  f.state.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
  const one = ensureCloudConnectionReady('cloud', { isOnline: async () => true })
  const two = ensureCloudConnectionReady('cloud', { isOnline: async () => true })
  expect(one).toBe(two)
  answer(snap('awake'))
  await one
  await ensureCloudConnectionReady('cloud', { isOnline: async () => true })
  expect(f.state).toHaveBeenCalledTimes(3)
})

it('account changes abort the old check before any wake under the next account', async () => {
  let answer!: (value: CloudComputerSnapshot) => void
  f.state.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
  const old = ensureCloudConnectionReady('cloud', { isOnline: async () => true })
  signIn('someone-else')
  answer(snap('asleep'))
  await expect(old).rejects.toThrow()
  expect(f.wake).not.toHaveBeenCalled()
})

it('cancels the last explicit waiter and sends no wake from a late state response', async () => {
  let answer!: (value: CloudComputerSnapshot) => void
  let signal: AbortSignal | undefined
  f.state.mockImplementationOnce((abort: AbortSignal) => { signal = abort; return new Promise(resolve => { answer = resolve }) })
  const abort = new AbortController()
  const run = ensureCloudConnectionReady('cloud', { isOnline: async () => true, signal: abort.signal })
  abort.abort()
  await expect(run).rejects.toMatchObject({ name: 'AbortError' })
  expect(signal?.aborted).toBe(true)
  answer(snap('asleep'))
  await Promise.resolve()
  expect(f.wake).not.toHaveBeenCalled()
})

it('keeps a shared wake alive for another explicit waiter after cancellation', async () => {
  let answer!: (value: CloudComputerSnapshot) => void
  let signal: AbortSignal | undefined
  f.state.mockImplementationOnce((abort: AbortSignal) => { signal = abort; return new Promise(resolve => { answer = resolve }) })
  const abort = new AbortController()
  const cancelled = ensureCloudConnectionReady('cloud', { isOnline: async () => true, signal: abort.signal })
  const other = ensureCloudConnectionReady('cloud', { isOnline: async () => true })
  abort.abort()
  await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
  expect(signal?.aborted).toBe(false)
  answer(snap('awake'))
  await other
  expect(f.state).toHaveBeenCalledTimes(2)
})

it('aborts an already issued wake request when its last waiter cancels', async () => {
  f.state.mockResolvedValue(snap('asleep'))
  let signal: AbortSignal | undefined
  f.wake.mockImplementationOnce((_input: unknown, abort: AbortSignal) => {
    signal = abort
    return new Promise((_resolve, reject) => abort.addEventListener('abort', () => reject(abort.reason), { once: true }))
  })
  const abort = new AbortController()
  const run = ensureCloudConnectionReady('cloud', { isOnline: async () => true, signal: abort.signal })
  await vi.waitFor(() => expect(f.wake).toHaveBeenCalledOnce())
  abort.abort()
  await expect(run).rejects.toMatchObject({ name: 'AbortError' })
  expect(signal?.aborted).toBe(true)
  expect(f.state).toHaveBeenCalledTimes(2) // Initial refresh plus this attempt; no more polling.
})
