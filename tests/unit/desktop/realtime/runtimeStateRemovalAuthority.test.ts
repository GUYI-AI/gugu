import { expect, it, vi } from 'vitest'
import { createAgentRuntimeStatePublisher, publishAgentStatusTransitions, type PublishedAgentStatus } from '@gugu/core/cloud/deviceRuntimeSweep'

const state = (agentUserId = 'agent') => ({ agentUserId, activityStatus: 'running' as const, agentStatus: 'working' as const, agentStatusDetail: 'running' as const })

it('withdraws publication before cloud removal and drains the already admitted write', async () => {
  const published = new Map<string, PublishedAgentStatus>()
  const publish = createAgentRuntimeStatePublisher({ published })
  const response = Promise.withResolvers<void>()
  const report = vi.fn(() => response.promise)
  const writing = publish(() => state(), report)
  await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1))
  let drained = false
  const removal = publish.beginRemoval('agent').then(settle => { drained = true; return settle })
  await Promise.resolve()
  expect(drained).toBe(false)
  expect(await publish(() => state(), report)).toBe(false)
  response.resolve()
  await writing
  const settle = await removal
  expect(drained).toBe(true)
  settle(true)
  expect(published.has('agent')).toBe(false)
  expect(await publish(() => state(), report)).toBe(false)
  expect(report).toHaveBeenCalledTimes(1)
})

it('restores publication when removal fails without blocking a different identity', async () => {
  const publish = createAgentRuntimeStatePublisher()
  const report = vi.fn(async () => {})
  const settle = await publish.beginRemoval('agent')
  expect(await publish(() => state(), report)).toBe(false)
  expect(await publish(() => state('other'), report)).toBe(true)
  settle(false)
  expect(await publish(() => state(), report)).toBe(true)
  expect(report.mock.calls).toHaveLength(2)
})

it('does not cache a state that the publication owner withdrew', async () => {
  const published = new Map<string, PublishedAgentStatus>()
  await publishAgentStatusTransitions({ agentUserIds: ['agent'], published,
    statusOf: () => ({ status: 'working', detail: 'running', running: true, background: null }),
    report: async () => false, shouldBail: () => false })
  expect(published.has('agent')).toBe(false)
})

it.each([false, true])('does not let a failed concurrent removal reopen a confirmed or still pending one (%s)', async confirmed => {
  const publish = createAgentRuntimeStatePublisher()
  const first = await publish.beginRemoval('agent')
  const second = await publish.beginRemoval('agent')
  first(false)
  expect(publish.canPublish('agent')).toBe(false)
  second(confirmed)
  expect(publish.canPublish('agent')).toBe(!confirmed)
})
