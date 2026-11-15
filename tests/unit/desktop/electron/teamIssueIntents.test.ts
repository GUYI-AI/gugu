import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createTeamIssueIntentStore, type TeamIssueBody, type TeamIssueSlot } from '../../../../apps/desktop/electron/team-issue-intents'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const slot: TeamIssueSlot = { actorUserId: 'actor-a', localTaskId: 'task-a', agentUserId: 'agent-a', engineId: 'codex',
  modelId: 'model-a', protocol: 'openai-responses', providerSessionId: null, keepFromAccessSessionId: null }
const body: TeamIssueBody = { action: 'issue', agent_user_id: 'agent-a', engine_id: 'codex', model_id: 'model-a',
  protocol: 'openai-responses', provider_session_id: null, team_id: 'team-a', member_identity_id: 'actor-a',
  task_id: 'task-a', expected_membership_revision: 7 }
async function setup() { const root = await mkdtemp(join(tmpdir(), 'team-issue-intent-')); roots.push(root); return root }

it('recovers the exact UUID and original request after a response loss and restart', async () => {
  const root = await setup(), first = await createTeamIssueIntentStore(root).prepare(slot, body, 'auth-session-a')
  const reopened = createTeamIssueIntentStore(root)
  expect(await reopened.prepare(slot, { ...body, expected_membership_revision: 9 }, 'auth-session-a')).toEqual(first)
  expect(first.idempotency_key).toMatch(/^[0-9a-f-]{36}$/)
  expect(first.body.expected_membership_revision).toBe(7)
})
it('ends a completed issue and gives a new logical issue or keep-from rotation a new key', async () => {
  const store = createTeamIssueIntentStore(await setup()), first = await store.prepare(slot, body, 'auth-session-a')
  await store.finish(slot, first)
  const next = await store.prepare(slot, body, 'auth-session-a')
  expect(next.idempotency_key).not.toBe(first.idempotency_key)
  const rotated = await store.prepare({ ...slot, keepFromAccessSessionId: 'old-ticket' }, { ...body, keep_from_session_id: 'old-ticket' }, 'auth-session-a')
  expect(rotated.idempotency_key).not.toBe(next.idempotency_key)
  expect(rotated.body.task_id).toBe(first.body.task_id)
})
it('coalesces concurrent utility issues and never lets a late completion clear a newer intent', async () => {
  const root = await setup(), utility = { ...slot, localTaskId: null }
  const values = await Promise.all(Array.from({ length: 8 }, (_, index) => createTeamIssueIntentStore(root).prepare(utility, { ...body, task_id: `utility-${index}` }, 'auth-session-a')))
  expect(new Set(values.map(value => value.idempotency_key)).size).toBe(1)
  expect(new Set(values.map(value => value.body.task_id)).size).toBe(1)
  const store = createTeamIssueIntentStore(root)
  await store.finish(utility, values[0])
  const next = await store.prepare(utility, { ...body, task_id: 'new-utility' }, 'auth-session-a')
  await store.finish(utility, values[0])
  expect((await store.read(utility))?.idempotency_key).toBe(next.idempotency_key)
})
it('persists only identifiers and refuses corrupt state instead of silently issuing a second ticket', async () => {
  const root = await setup(), store = createTeamIssueIntentStore(root)
  await store.prepare(slot, { ...body, access_token: 'synthetic-secret' } as TeamIssueBody, 'auth-session-a')
  const directory = join(root, 'team-issue-intents'), files = (await readdir(directory)).filter(file => file.endsWith('.json'))
  const path = join(directory, files[0]), raw = await readFile(path, 'utf8')
  expect(raw).not.toContain('synthetic-secret')
  await writeFile(path, '{invalid')
  await expect(store.prepare(slot, body, 'auth-session-a')).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe('{invalid')
})

it('keeps a pending issue under its original login session rather than rotating the UUID after sign-in', async () => {
  const store = createTeamIssueIntentStore(await setup()), first = await store.prepare(slot, body, 'auth-session-a')
  await expect(store.prepare(slot, body, 'auth-session-b')).rejects.toMatchObject({ code: 'team_task_auth_session_changed' })
  expect(await store.read(slot)).toEqual(first)
})
