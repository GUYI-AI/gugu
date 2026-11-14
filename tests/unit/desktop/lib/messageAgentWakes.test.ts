import { beforeEach, expect, it, vi } from 'vitest'

const load = vi.hoisted(() => vi.fn<(ids: string[]) => Promise<Map<string, Set<string>>>>())
const logError = vi.hoisted(() => vi.fn())
vi.mock('@/lib/chatMessageRevalidation', () => ({ loadMessageAgentWakes: load }))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ error: logError }) }))
const backend = vi.hoisted(() => ({ recovered: new Set<() => void>(), probes: 0 }))
vi.mock('@gugu/core/cloud/backendReachability', () => ({
  noteBackendRequestFailed: () => { backend.probes += 1 },
  subscribeBackendRecovered: (listener: () => void) => { backend.recovered.add(listener); return () => { backend.recovered.delete(listener) } },
}))
const recover = () => { for (const listener of [...backend.recovered]) listener() }

const { forgetMessageAgentWakes, knownMessageAgentWakes, knownMessageAgentWakesKey, requestMessageAgentWakes, subscribeMessageAgentWakes } =
  await import('@/lib/messageAgentWakes')

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  forgetMessageAgentWakes()
  load.mockReset()
  logError.mockReset()
  backend.probes = 0
})

it('reads each message once for every view of the account', async () => {
  load.mockImplementation(async (ids) => new Map(ids.map((id) => [id, new Set(['agent-a'])])))
  const heard = vi.fn()
  const stop = subscribeMessageAgentWakes(heard)
  requestMessageAgentWakes(['m1', 'm2'])
  requestMessageAgentWakes(['m1', 'm2', 'm3']) // m1, m2 are in flight: only m3 is asked
  await settle()
  requestMessageAgentWakes(['m1', 'm3'])
  expect(load.mock.calls).toEqual([[['m1', 'm2']], [['m3']]])
  expect(knownMessageAgentWakesKey(['m3', 'm1', 'x'])).toBe('m3,m1')
  expect([...knownMessageAgentWakes('m2')!]).toEqual(['agent-a'])
  expect(heard).toHaveBeenCalled()
  stop()
})

it('logs a failed read and does not ask again in a loop', async () => {
  load.mockRejectedValue(new Error('Message recipients are unavailable: offline'))
  requestMessageAgentWakes(['m1'])
  await settle()
  requestMessageAgentWakes(['m1'])
  await settle()
  expect(load).toHaveBeenCalledTimes(1)
  expect(logError).toHaveBeenCalledOnce()
  expect(knownMessageAgentWakesKey(['m1'])).toBe('')
})

it('a failed read asks the beat to probe and is read once more when the backend answers again', async () => {
  load.mockRejectedValueOnce(new Error('Message recipients are unavailable: offline'))
  requestMessageAgentWakes(['m1', 'm2'])
  await settle()
  expect(backend.probes).toBe(1)
  expect(backend.recovered.size).toBe(1)
  load.mockResolvedValueOnce(new Map([['m1', new Set(['agent-a'])], ['m2', new Set<string>()]]))
  recover()
  await settle()
  expect(load.mock.calls).toEqual([[['m1', 'm2']], [['m1', 'm2']]])
  expect(knownMessageAgentWakesKey(['m1', 'm2'])).toBe('m1,m2')
  expect(backend.recovered.size).toBe(0)
  recover() // nothing left to retry: no third read
  await settle()
  expect(load).toHaveBeenCalledTimes(2)
})

it('an account switch drops the pending retry of the previous account', async () => {
  load.mockRejectedValueOnce(new Error('down'))
  requestMessageAgentWakes(['old'])
  await settle()
  forgetMessageAgentWakes()
  expect(backend.recovered.size).toBe(0)
  recover()
  await settle()
  expect(load).toHaveBeenCalledTimes(1)
})

it('an account switch forgets everything, and an answer for the previous account is dropped', async () => {
  let answer!: (wakes: Map<string, Set<string>>) => void
  load.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
  requestMessageAgentWakes(['old'])
  forgetMessageAgentWakes()
  answer(new Map([['old', new Set(['agent-a'])]]))
  await settle()
  expect(knownMessageAgentWakesKey(['old'])).toBe('')

  load.mockRejectedValueOnce(new Error('down'))
  requestMessageAgentWakes(['failed'])
  await settle()
  forgetMessageAgentWakes()
  load.mockResolvedValueOnce(new Map([['failed', new Set<string>()]]))
  requestMessageAgentWakes(['failed']) // the next account may read what the previous one could not
  await settle()
  expect(knownMessageAgentWakesKey(['failed'])).toBe('failed')
})
