// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { createConnectionRouting, type ConnectionRoute } from '@gugu/core/cloud/connectionRouting'
import { followRendererSession, queryClient } from '@/lib/replica'
import { connectionRoute, routeCache } from '@/lib/connectionBridge'

const OWNER = 'route-owner'
let answer: ConnectionRoute
const routing = createConnectionRouting({ accountId: () => OWNER, read: async () => answer, changed: () => {}, cache: routeCache })

beforeEach(() => {
  followRendererSession('SIGNED_IN', OWNER)
  queryClient.removeQueries({ queryKey: [connectionRoute.name] })
  answer = { mode: 'owner', epoch: '3', phase: 'stable', acceptingNewOperations: true }
})

// One copy (D inventory, connectionRoute): core routing's last route is the replica's entry, not a map beside it.
describe('connectionRoute', () => {
  it('a route routing reads lands in the replica entry, and routing peeks that entry', async () => {
    await routing.read()
    const reading = connectionRoute.peek()
    expect(reading.state === 'value' && reading.value.epoch).toBe('3')
    connectionRoute.set([], { ...answer, epoch: '5' })
    expect(routing.peek()?.epoch).toBe('5')
  })

  it('an older epoch than the kept one is refused by routing (the epoch check reads the entry)', async () => {
    connectionRoute.set([], { ...answer, epoch: '7' })
    await expect(routing.read()).rejects.toMatchObject({ code: 'route-changed' })
  })

  it('another account\'s route is not kept under this one', async () => {
    followRendererSession('SIGNED_IN', 'someone-else')
    routeCache.set(OWNER, answer)
    expect(routeCache.get(OWNER)).toBeUndefined()
  })
})
