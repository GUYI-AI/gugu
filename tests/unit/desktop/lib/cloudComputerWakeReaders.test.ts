// E-2: the cloud computer's two readers — the replica's poll and the wake loop's own /state answers — and the wake refusal.
import { beforeEach, expect, it, vi } from 'vitest'
import { QueryObserver } from '@tanstack/react-query'
import type { CloudComputerSnapshot } from '@gugu/core/cloud/cloudComputer'

const calls: Array<(snapshot: CloudComputerSnapshot) => void> = []
const wake = vi.hoisted(() => ({ reject: null as unknown }))
vi.mock('@/lib/cloudComputerClient', () => ({
  rendererCloudComputerClient: () => ({
    state: () => new Promise<CloudComputerSnapshot>((resolve) => { calls.push(resolve) }),
    wake: async () => { if (wake.reject) throw wake.reject },
  }),
}))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }))
const loop = vi.hoisted(() => ({ onSnapshot: null as null | ((snapshot: CloudComputerSnapshot) => void) }))
vi.mock('@gugu/core/cloud/cloudComputer', async (original) => ({
  ...await original<object>(),
  // The wake loop: hands its /state answers over, and waits.
  wakeCloudComputerUntilOnline: (input: { onSnapshot: (snapshot: CloudComputerSnapshot) => void }) => { loop.onSnapshot = input.onSnapshot; return new Promise(() => {}) },
}))

const { cloudComputer, wakeAndWaitOnline, wakeCloudComputer, wakeRefusals } = await import('@/lib/cloudComputer')
const { publishRendererSession } = await import('@/lib/sessionPublication')
const { queryClient } = await import('@/lib/replica')
const { CloudComputerError } = await import('@gugu/core/cloud/cloudComputer')

const snap = (state: CloudComputerSnapshot['state']): CloudComputerSnapshot => ({ state, deviceId: 'dev-cloud', error: null, since: null })
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

beforeEach(() => {
  calls.length = 0
  wake.reject = null
  publishRendererSession('SIGNED_IN', { user: { id: 'previous' }, access_token: 't' } as never)
  publishRendererSession('SIGNED_IN', { user: { id: 'owner' }, access_token: 't' } as never)
})

it('a poll asked before the wake loop\'s answer does not cover it when it lands later', async () => {
  // Shown (the devices provider always shows it): its read is the poll.
  const shown = new QueryObserver(queryClient, cloudComputer.options(cloudComputer.key()!) as never)
  const stop = shown.subscribe(() => undefined)
  await settle()
  calls[0]!(snap('asleep'))
  await settle()
  void cloudComputer.refresh()
  await settle()
  const poll = calls.length - 1
  void wakeAndWaitOnline('dev-cloud', { isOnline: async () => false })
  loop.onSnapshot!(snap('waking'))
  await settle()
  // The poll asked before the wake loop's answer lands now, older.
  calls[poll]!(snap('asleep'))
  await settle()
  expect(cloudComputer.peek()).toMatchObject({ state: 'value', value: { snapshot: { state: 'waking' } } })
  stop()
})

it('a wake refusal ends when the machine leaves asleep (❌ said again the next time it sleeps)', async () => {
  cloudComputer.set([], { available: true, snapshot: snap('asleep') })
  wake.reject = new CloudComputerError(402, 'credits_exhausted', 'no credits')
  await expect(wakeCloudComputer()).rejects.toThrow()
  expect(wakeRefusals.get()).toEqual({ 'dev-cloud': 'credits_exhausted' })
  // Topped up and woken elsewhere.
  cloudComputer.set([], { available: true, snapshot: snap('awake') })
  expect(wakeRefusals.get()).toEqual({})
})
