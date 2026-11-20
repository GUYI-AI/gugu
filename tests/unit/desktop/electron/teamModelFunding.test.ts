import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { teamIssueContext, assertSameTeamFunding, assertTeamTaskSession, teamModelStopReason, TeamFundingError } from '../../../../apps/desktop/electron/team-model-funding'
import { createTaskPayerStore } from '../../../../apps/desktop/electron/task-payer-store'
import { teamAccountTokenHint } from '../../../../apps/desktop/shared/team-account-claims'
import { claimDeviceFreeCredits } from '../../../../apps/desktop/electron/device-free-credits'
import { teamCreditReason } from '@gugu/session-core/session-record/team-credits'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const jwt = (kind: string) => `header.${Buffer.from(JSON.stringify({ sub: 'actor-team', app_metadata: { gugu_account_kind: kind } })).toString('base64url')}.signature`
const auth = { userId: 'actor-team', accessToken: jwt('team_member') }
const funding = { kind: 'team' as const, team_id: 'team-a', member_id: 'member-a', task_id: 'task-a', unit_version: 2 as const, locked_at: '2026-11-15T00:00:00Z' }
const identity = { actorUserId: auth.userId, memberIdentityId: auth.userId, funding }
const context = { kind: 'team', team_id: 'team-a', member_id: 'member-a', member_identity_id: auth.userId, member_state: 'active', membership_revision: 7, stop_reason: null }

it('binds live tickets to the Auth session while allowing token refresh within that same session', () => {
  const token = (session: string, extra = {}) => `head.${Buffer.from(JSON.stringify({ sub: auth.userId, session_id: session, app_metadata: { gugu_account_kind: 'team_member' }, ...extra })).toString('base64url')}.signature`
  const bound = { ...identity, authSessionId: 'original-session' }
  expect(() => assertTeamTaskSession({ ...auth, accessToken: token('original-session', { exp: 9999999999 }) }, bound)).not.toThrow()
  expect(() => assertTeamTaskSession({ ...auth, accessToken: token('another-session') }, bound)).toThrow(expect.objectContaining({ code: 'team_task_auth_session_changed' }))
  expect(() => assertTeamTaskSession(auth, identity)).toThrow(expect.objectContaining({ code: 'team_task_auth_session_changed' }))
})

it('retains task ownership after settlement/restart and rejects a switch to personal or another team', async () => {
  const root = await mkdtemp(join(tmpdir(), 'team-task-payer-')); roots.push(root)
  const store = createTaskPayerStore(root), payer = { version: 1 as const, taskId: 'task-a', actorUserId: auth.userId, kind: 'team' as const, teamId: 'team-a', memberIdentityId: auth.userId }
  await store.reserve(payer); await store.lockTeam('task-a', identity)
  const reopened = createTaskPayerStore(root)
  expect((await reopened.read('task-a'))?.teamTask?.funding).toEqual(funding)
  await expect(reopened.reserve({ ...payer, kind: 'personal', teamId: undefined, memberIdentityId: undefined })).rejects.toMatchObject({ code: 'team_identity_required' })
  await expect(reopened.reserve({ ...payer, teamId: 'team-b' })).rejects.toMatchObject({ code: 'team_identity_required' })
  expect((await reopened.read('task-a'))?.teamId).toBe('team-a')
})
it('checks the original actor before any HTTP call, including when the current account is personal', async () => {
  const fetcher = vi.fn()
  await expect(teamIssueContext({ userId: 'actor-personal', accessToken: jwt('personal') }, 'task-a', fetcher, identity)).rejects.toMatchObject({ code: 'team_identity_required' })
  expect(fetcher).not.toHaveBeenCalled()
})
it('uses the original team token and task while reading authoritative stop reasons', async () => {
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ ok: true, data: { ...context, stop_reason: 'team_credits_exhausted' } })))
  await expect(teamIssueContext(auth, 'task-a', fetcher, identity)).rejects.toMatchObject({ code: 'credits_exhausted', reason_code: 'team_credits_exhausted' })
  expect(fetcher.mock.calls[0][1]).toEqual(expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ Authorization: `Bearer ${auth.accessToken}` }) }))
})
it('refuses a context for a different Auth principal before any model ticket is issued', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { ...context, member_identity_id: 'another-principal' } })))
  await expect(teamIssueContext(auth, 'task-a', fetcher)).rejects.toMatchObject({ code: 'team_identity_required' })
})
it('refuses missing/changed funding and never uses a personal fallback for a failed context read', async () => {
  expect(() => assertSameTeamFunding({ ...funding, task_id: 'task-b' }, funding)).toThrow()
  await expect(teamIssueContext(auth, 'task-a', async () => { throw new Error('offline') }, identity)).rejects.toThrow('offline')
  expect(teamModelStopReason(new Error('private', { cause: new TeamFundingError('credits_exhausted', 'team_member_monthly_cap_reached') }))).toBe('team_member_monthly_cap_reached')
})
it('keeps team and login-anchor identities out of device gifts', async () => {
  const claim = vi.fn(), machineId = vi.fn()
  for (const kind of ['team_member', 'team_login_anchor', 'unknown']) {
    await expect(claimDeviceFreeCredits({ claim, machineId, storePath: '/unused', warn: vi.fn() }, { ...auth, accessToken: jwt(kind) })).resolves.toBeNull()
  }
  expect(claim).not.toHaveBeenCalled(); expect(machineId).not.toHaveBeenCalled()
  expect(teamAccountTokenHint(jwt('team_member'))).toBe('team')
})
it('uses structured team reason codes rather than gateway text or HTTP guesses', () => {
  expect(teamCreditReason('{"error":{"code":"credits_exhausted","reason_code":"team_credits_exhausted","message":"private"}}')).toBe('team_credits_exhausted')
  expect(teamCreditReason('{"error":{"code":"credits_exhausted","message":"team_credits_exhausted"}}')).toBeNull()
  expect(teamCreditReason('{"error":{"code":"forbidden","reason_code":"team_credits_exhausted"}}')).toBeNull()
})

it('atomically reserves one payer across concurrent requests without partial JSON or overwriting the winner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'team-task-race-')); roots.push(root)
  const payer = { version: 1 as const, taskId: 'task-race', actorUserId: 'actor-a', kind: 'personal' as const }
  const stores = Array.from({ length: 12 }, () => createTaskPayerStore(root))
  await expect(Promise.all(stores.map(store => store.reserve(payer)))).resolves.toHaveLength(12)
  await expect(stores[0].reserve({ ...payer, actorUserId: 'actor-b' })).rejects.toMatchObject({ code: 'team_identity_required' })
  expect(await stores[0].read('task-race')).toEqual(payer)
})
