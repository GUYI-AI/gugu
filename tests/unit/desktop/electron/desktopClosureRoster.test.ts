import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { agentsFile, listAgents, type LocalAgentRecord } from '@gugu/core/local/state/agents'
import { AGENT_OWNER_CACHE_KEY } from '@gugu/core/local/state/agentOwner'
import { reapedAgentsFile } from '@gugu/core/local/state/agentTombstones'
import { eraseClosedAccountRoster } from '../../../../apps/desktop/electron/account-closure/roster'

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true }) })
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'closure-roster-')); roots.push(home)
  const env = { GUGU_HOME: home }
  const record = (name: string, owner?: string): LocalAgentRecord => ({ name, agent_type: 'claude-code', path: '/retained-workspace',
    gugu_user_id: name, prompt: '', created_at: 1, ...(owner ? { cache: { [AGENT_OWNER_CACHE_KEY]: owner } } : {}) })
  const records = [record('a', A), record('b', B), record('unknown')]
  await mkdir(dirname(agentsFile(env)), { recursive: true })
  await writeFile(agentsFile(env), JSON.stringify({ agents: records }))
  return { env, records }
}
describe('confirmed account local roster cleanup', () => {
  it('erases only exact A attribution, retaining B and unknown records without writing identity tombstones', async () => {
    const f = await fixture()
    await eraseClosedAccountRoster({ ownerId: A, localOperationId: 'opaque' }, f.env)
    expect(await listAgents(f.env, { includeGuests: true })).toEqual(f.records.slice(1))
    await expect(readFile(reapedAgentsFile(f.env))).rejects.toMatchObject({ code: 'ENOENT' })
    await eraseClosedAccountRoster({ ownerId: A, localOperationId: 'opaque' }, f.env)
    expect(await listAgents(f.env, { includeGuests: true })).toEqual(f.records.slice(1))
  })
  it('refuses an invalid scope before changing the roster', async () => {
    const f = await fixture(), before = await readFile(agentsFile(f.env), 'utf8')
    await expect(eraseClosedAccountRoster({ ownerId: '../' + B, localOperationId: 'opaque' }, f.env)).rejects.toThrow()
    expect(await readFile(agentsFile(f.env), 'utf8')).toBe(before)
  })
  it('propagates a corrupt roster instead of treating it as successful empty cleanup', async () => {
    const f = await fixture(); await writeFile(agentsFile(f.env), '{corrupt')
    await expect(eraseClosedAccountRoster({ ownerId: A, localOperationId: 'opaque' }, f.env)).rejects.toThrow()
    expect(await readFile(agentsFile(f.env), 'utf8')).toBe('{corrupt')
  })
})
