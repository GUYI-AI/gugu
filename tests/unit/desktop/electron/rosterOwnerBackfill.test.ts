import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestLocalAgent, isolatedGuguEnv } from '../../../support/deviceRuntimeHarness'
import { listAgents } from '@gugu/core'
import { agentsForOwner } from '@gugu/core/local/state/agentOwner'
import { createSessionpageIdentityHost } from '../../../../apps/desktop/electron/sessionpage/sessionpage-identity-host'

// One identity read: users whose id is among the ownerless rows and whose owner is the signed-in account.
const cloud = vi.hoisted(() => ({ read: vi.fn(), filters: [] as unknown[][] }))
vi.mock('../../../../apps/desktop/electron/supabase', () => ({
  electronFetch: vi.fn(),
  makeIdentityClient: () => {
    const query = {
      select: () => query,
      in: (...args: unknown[]) => { cloud.filters.push(['in', ...args]); return query },
      eq: (...args: unknown[]) => { cloud.filters.push(['eq', ...args]); return cloud.read() },
    }
    return { from: () => query }
  },
}))

const auth = { accessToken: 'test-token', refreshToken: '', userId: 'me' }
const host = (env: NodeJS.ProcessEnv) => createSessionpageIdentityHost({
  env, getAuth: async () => auth, resolveDeviceId: async () => 'device',
  resolveProjectName: async () => 'Project', sessionFacts: async () => null, listSessionFacts: async () => [],
})
const owners = async (env: NodeJS.ProcessEnv) => Object.fromEntries((await listAgents(env, { includeGuests: true }))
  .map((agent) => [agent.gugu_user_id, agent.cache?.sessionpage_owner_user_id ?? null]))

beforeEach(() => { cloud.read.mockReset(); cloud.filters.length = 0 })

describe('an ownerless roster row (written before rows carried an owner)', () => {
  it('belongs to no account until the cloud says whose it is; only an explicit { all: true } reads the whole roster', () => {
    const ownerless = { gugu_user_id: 'old', cache: {} }
    const mine = { gugu_user_id: 'mine', cache: { sessionpage_owner_user_id: 'me' } }
    expect(agentsForOwner([ownerless, mine], 'me')).toEqual([mine])
    expect(agentsForOwner([ownerless, mine], null)).toEqual([])
    expect(agentsForOwner([ownerless, mine], { all: true })).toEqual([ownerless, mine])
  })

  it('is adopted by the signed-in account when the cloud says it is that account\'s, and stays ownerless otherwise', async () => {
    const env = await isolatedGuguEnv('gugu-owner-backfill-')
    await createTestLocalAgent(env, { gugu_user_id: 'old-mine' }, { cache: {} })
    await createTestLocalAgent(env, { gugu_user_id: 'old-foreign' }, { cache: {} })
    await createTestLocalAgent(env, { gugu_user_id: 'recorded' }, { cache: { sessionpage_owner_user_id: 'someone' } })
    cloud.read.mockResolvedValueOnce({ data: [{ id: 'old-mine' }], error: null })
    await host(env).adoptRosterOwners()
    expect(cloud.filters).toEqual([['in', 'id', ['old-mine', 'old-foreign']], ['eq', 'owner_user_id', 'me']])
    expect(await owners(env)).toEqual({ 'old-mine': 'me', 'old-foreign': null, recorded: 'someone' })
  })

  it('throws when the owner read fails, and adopts nothing: a failure is never read as mine', async () => {
    const env = await isolatedGuguEnv('gugu-owner-backfill-fail-')
    await createTestLocalAgent(env, { gugu_user_id: 'old' }, { cache: {} })
    cloud.read.mockResolvedValueOnce({ data: null, error: { message: 'network down' } })
    await expect(host(env).adoptRosterOwners()).rejects.toThrow('owner read failed for 1 ownerless roster row(s): network down')
    expect(await owners(env)).toEqual({ old: null })
    expect(agentsForOwner(await listAgents(env, { includeGuests: true }), 'me')).toEqual([])
  })
})
