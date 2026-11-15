import { describe, expect, it, vi } from 'vitest'
import { createTeamApi, type TeamRequest } from '../../../apps/desktop/src/features/team/api'
import { TeamApiError } from '../../../apps/desktop/src/features/team/errors'
import { myUsage, currentContext, members, profile } from '../../../apps/desktop/src/features/team/readers'
import { creditDecimal as cd } from '@gugu/core/billing/creditAmount'
import { mockTeamApi, teamContext, teamSignIn, teamProfile } from '../../fixtures/teamEdition'

describe('team HTTP contract boundary', () => {
  it('accepts unprovisioned pending rows but never treats their membership ID as an Auth principal', () => {
    const person = { id: 'pending-membership', identity_id: null, name: '待加入成员', email: 'pending@example.test', role: 'member', revision: 0 }
    expect(members({ members: [{ ...person, state: 'provisioning' }], next_cursor: null }).members[0].identity_id).toBeNull()
    expect(() => members({ members: [{ ...person, state: 'active' }], next_cursor: null })).toThrow()
  })
  it('requires the complete top-level Realtime namespace and matching membership revision in verified profiles', () => {
    const value = teamProfile()
    expect(profile(value).realtime_namespace).toBe(value.realtime_namespace)
    expect(() => profile({ ...value, realtime_namespace: undefined })).toThrow()
    expect(() => profile({ ...value, membership_revision: value.membership_revision + 1 })).toThrow()
  })
  it('uses GET for reads, carries only the opaque cursor, and keeps personal cap headroom separate', async () => {
    const fixture = await mockTeamApi().myUsage()
    const transport = vi.fn(async (_request: TeamRequest) => ({ ok: true, data: fixture }))
    const result = await createTeamApi(transport).myUsage({ cursor: 'opaque:do-not-parse' })
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'team-billing', action: 'my_usage', method: 'GET', body: { cursor: 'opaque:do-not-parse' } }))
    expect(result.headroom_credits).toBe('74')
    expect(result).not.toHaveProperty('team_balance_credits')
  })
  it('uses financial cap revisions and sends a batch as one atomic command', async () => {
    const transport = vi.fn(async () => ({ ok: true, data: { members: [
      { member_id: 'a', cap_credits: '200', used_credits: '126', revision: 18, stop_reason: null },
      { member_id: 'b', cap_credits: null, used_credits: '1', revision: 1, stop_reason: null },
    ] } }))
    await createTeamApi(transport).setCaps([{ member_id: 'a', cap_credits: cd('200'), expected_revision: 17 }, { member_id: 'b', cap_credits: null, expected_revision: 0 }], 'command-fixture')
    expect(transport).toHaveBeenCalledOnce()
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', action: 'set_caps', body: { idempotency_key: 'command-fixture',
      members: [{ member_id: 'a', cap_credits: '200', expected_revision: 17 }, { member_id: 'b', cap_credits: null, expected_revision: 0 }] } }))
  })
  it('rejects duplicate targets before sending and refuses a successful partial batch', async () => {
    const transport = vi.fn(async () => ({ ok: true, data: { members: [] } }))
    const api = createTeamApi(transport), member = { member_id: 'a', cap_credits: null, expected_revision: 0 }
    await expect(api.setCaps([member, member], 'k')).rejects.toMatchObject({ code: 'invalid_request' })
    expect(transport).not.toHaveBeenCalled()
    await expect(api.setCaps([member], 'k')).rejects.toMatchObject({ code: 'invalid_response' })
  })
  it.each(['team_member_monthly_cap_reached', 'team_credits_exhausted'])('preserves stable refusal %s without exposing server diagnostics', async reason => {
    const api = createTeamApi(async () => ({ ok: false, status: 409, error: { code: 'credits_exhausted', reason_code: reason, message: 'private gateway body' } }))
    const error = await api.context().catch(error => error)
    expect(error).toBeInstanceOf(TeamApiError)
    expect(error.reason_code).toBe(reason)
    expect(JSON.stringify(error)).not.toContain('private gateway body')
    expect(error.message).not.toContain('private gateway body')
  })
  it('does not accept a personal OAuth proof as the final team session', async () => {
    const value = teamSignIn(); value.session.user.app_metadata = {}
    await expect(createTeamApi(async () => ({ ok: true, data: value })).googleSignIn({ access_token: 'proof-only' })).rejects.toMatchObject({ code: 'team_identity_required' })
  })
  it('rejects a team-marked session whose Auth principal differs from the canonical member identity', async () => {
    const value = teamSignIn(); value.session.user.id = 'another-principal'
    await expect(createTeamApi(async () => ({ ok: true, data: value })).signIn('verified-receipt')).rejects.toMatchObject({ code: 'team_identity_required' })
  })
  it('never reports a completed disablement without all effective-access checks', async () => {
    const api = createTeamApi(async () => ({ ok: true, data: { state: 'complete', checks: { new_data_calls_denied: true, new_model_calls_denied: true, session_followups_stopped: false } } }))
    await expect(api.revocationResult('operation-fixture')).rejects.toMatchObject({ code: 'revocation_pending' })
  })
  it('preserves a small negative team balance while rejecting malformed money/record time', async () => {
    const usage = await mockTeamApi().myUsage()
    expect(() => myUsage({ ...usage, records: [{ ...usage.records[0], occurred_at: 'later' }] })).toThrow()
    expect(() => myUsage({ ...usage, records: [{ ...usage.records[0], credits: '-1' }] })).toThrow()
    expect(() => currentContext({ ...teamContext(), used_credits: NaN })).toThrow()
    const data = { ...await mockTeamApi().summary(), team_balance_credits: '-0.02' }
    expect((await createTeamApi(async () => ({ ok: true, data })).summary()).team_balance_credits).toBe('-0.02')
  })
  it.each(['2026-11-15T05:00:00Z', '2026-11-15T05:00:00.123456+00:00'])('accepts the UTC usage timestamp %s', async occurred_at => {
    const usage = await mockTeamApi().myUsage()
    expect(myUsage({ ...usage, records: [{ ...usage.records[0], occurred_at }] }).records[0].occurred_at).toBe(occurred_at)
  })
  it.each(['2026-11-15T13:00:00+08:00', '2026-11-15T05:00:00', '2026-11-15T25:00:00+00:00'])('rejects non-UTC or invalid usage timestamp %s', async occurred_at => {
    const usage = await mockTeamApi().myUsage()
    expect(() => myUsage({ ...usage, records: [{ ...usage.records[0], occurred_at }] })).toThrow()
  })
})
