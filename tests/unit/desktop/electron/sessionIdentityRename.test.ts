import { describe, expect, it } from 'vitest'
import { listAgents } from '@gugu/core'
import { createTestLocalAgent, isolatedGuguEnv } from '../../../support/deviceRuntimeHarness'
import { createSessionpageIdentityHost } from '../../../../apps/desktop/electron/sessionpage/sessionpage-identity-host'

// Offline: the rename lands on the roster (pending) and nothing is published, so only the naming rule is read.
const host = (env: NodeJS.ProcessEnv) => createSessionpageIdentityHost({
  env, getAuth: async () => null, resolveDeviceId: async () => 'device',
  resolveProjectName: async () => 'Project', sessionFacts: async () => null, listSessionFacts: async () => [],
})
const agent = (env: NodeJS.ProcessEnv, id: string, name: string, owner = 'owner') =>
  createTestLocalAgent(env, { gugu_user_id: id, name }, { cache: { sessionpage_owner_user_id: owner } })
const nameOf = async (env: NodeJS.ProcessEnv, id: string) =>
  (await listAgents(env, { includeGuests: true })).find((row) => row.gugu_user_id === id)?.name

describe('renaming a bound task identity', () => {
  // A task dispatched with the words 「比尔」 was auto-named 「比尔」 next to the owner's existing 「比尔」.
  it('gives a name another of the owner\'s agents already has the next free numbered suffix', async () => {
    const env = await isolatedGuguEnv('gugu-rename-unique-')
    await agent(env, 'existing', '比尔')
    await agent(env, 'existing-2', '比尔 2')
    await agent(env, 'new-task', 'Codex 7')
    await host(env).renameBound('session', 'new-task', '比尔')
    expect(await nameOf(env, 'new-task')).toBe('比尔 3')
    expect(await nameOf(env, 'existing')).toBe('比尔')
  })

  it('keeps a name only this agent, or only another account\'s agent, carries', async () => {
    const env = await isolatedGuguEnv('gugu-rename-own-')
    await agent(env, 'new-task', '比尔')
    await agent(env, 'someone-else', '小弟', 'other-owner')
    await host(env).renameBound('session', 'new-task', '小弟')
    expect(await nameOf(env, 'new-task')).toBe('小弟')
  })
})
