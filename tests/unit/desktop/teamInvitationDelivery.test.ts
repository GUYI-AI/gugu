import { describe, expect, it, vi } from 'vitest'
import { createTeamApi, type TeamRequest } from '../../../apps/desktop/src/features/team/api'
import { invitationFailure, readInvitationReceipt } from '../../../apps/desktop/src/features/team/invitation-receipt'
import { createTeamInviteIntentStore } from '../../../apps/desktop/src/features/team/inviteIntentStore'
import { teamInvitationFixture, teamInvitationCapability } from '../../fixtures/teamEdition'
import type { TeamInvitationReceipt } from '../../../apps/desktop/src/features/team/types'

const key = '00000000-0000-4000-8000-000000000001'
function memory() {
  const values = new Map<string, string>()
  return { values, getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => { values.set(name, value) }, removeItem: (name: string) => { values.delete(name) } }
}
const unknown: TeamInvitationReceipt = { operation_id: null, invitation_created: null,
  delivery: { operation_id: null, state: 'unknown', reason_code: 'invitation_outcome_unknown' } }

describe('invitation delivery HTTP receipt', () => {
  it('keeps identity and mail operation IDs distinct and preserves the complete original command', async () => {
    const row = teamInvitationFixture(), transport = vi.fn(async (_request: TeamRequest) => ({ ok: true, data: row }))
    const result = await createTeamApi(transport).invite('Member@example.test', key)
    expect(result.operation_id).toBe('identity-operation-fixture')
    expect(result.delivery.operation_id).toBe('mail-operation-fixture')
    expect(result.delivery.state).toBe('accepted')
    expect(transport).toHaveBeenCalledExactlyOnceWith({ endpoint: 'team-accounts', action: 'invite', method: 'POST',
      body: { email: 'Member@example.test', role: 'member', idempotency_key: key } })
  })
  it.each([true, false, null])('reads partial failed data with invitation_created=%s without demanding links or expiry', async invitation_created => {
    const data = { ...unknown, invitation_created }
    const api = createTeamApi(async () => ({ ok: false, status: 503, data, error: { code: 'dependency_unavailable', message: 'private backend detail' } }))
    const error = await api.invite('member@example.test', key).catch(error => error)
    expect(error).toMatchObject({ code: 'dependency_unavailable', status: 503 })
    expect(invitationFailure(error)).toEqual({ receipt: data, invitation: null })
    expect(error.message).not.toContain('private backend detail')
  })
  it('makes verified failure links available only to the feature, never serialized errors', async () => {
    const data = { ...teamInvitationFixture(), delivery: { operation_id: 'mail-operation-fixture', state: 'failed', reason_code: 'smtp_rejected' } }
    const api = createTeamApi(async () => ({ ok: false, status: 503, data, error: { code: 'dependency_unavailable' } }))
    const error = await api.invite('member@example.test', key).catch(error => error)
    expect(invitationFailure(error)?.invitation?.invitation_url).toBe(data.invitation_url)
    expect(invitationFailure(error)?.receipt.delivery.state).toBe('failed')
    expect(JSON.stringify(error)).not.toContain(teamInvitationCapability)
    expect(JSON.stringify(error)).not.toContain('invitation_url')
  })
  it('does not invent links when the backend has not established an anchor', async () => {
    const data = { operation_id: 'identity-operation-fixture', invitation_created: true,
      delivery: { operation_id: 'mail-operation-fixture', state: 'failed', reason_code: 'identity_unavailable' } }
    const error = await createTeamApi(async () => ({ ok: false, status: 503, data, error: { code: 'dependency_unavailable' } })).invite('member@example.test', key).catch(error => error)
    expect(invitationFailure(error)?.receipt).toEqual(data)
    expect(invitationFailure(error)?.invitation).toBeNull()
  })
  it.each([
    { ...unknown, invitation_created: false, delivery: { ...unknown.delivery, state: 'accepted' } },
    { ...unknown, delivery: { ...unknown.delivery, state: 'delivered' } },
    { ...unknown, delivery: { ...unknown.delivery, reason_code: 'human readable server detail' } },
  ])('does not trust malformed delivery evidence %#', async data => {
    expect(() => readInvitationReceipt(data)).toThrow()
    const error = await createTeamApi(async () => ({ ok: false, status: 503, data, error: { code: 'dependency_unavailable' } })).invite('member@example.test', key).catch(error => error)
    expect(invitationFailure(error)).toBeUndefined()
  })
  it('rejects inconsistent link regions while retaining a valid minimal failed receipt', async () => {
    const data = teamInvitationFixture(); data.app_deep_links.beta = data.app_deep_links.beta.replace('region=cn', 'region=hk')
    await expect(createTeamApi(async () => ({ ok: true, data })).invite('member@example.test', key)).rejects.toMatchObject({ code: 'invalid_response' })
    const error = await createTeamApi(async () => ({ ok: false, status: 503, data, error: { code: 'dependency_unavailable' } })).invite('member@example.test', key).catch(error => error)
    expect(invitationFailure(error)?.receipt.invitation_created).toBe(true)
    expect(invitationFailure(error)?.invitation).toBeNull()
  })
  it('preserves authorization errors without treating missing receipt data as success', async () => {
    const error = await createTeamApi(async () => ({ ok: false, status: 403, error: { code: 'forbidden' } })).invite('member@example.test', key).catch(error => error)
    expect(error).toMatchObject({ code: 'forbidden', status: 403 })
    expect(invitationFailure(error)).toBeUndefined()
  })
})

describe('durable identity-scoped invitation commands', () => {
  it('recovers the exact key, original email case and separate receipts after closing or restarting', () => {
    const storage = memory(), newKey = vi.fn(() => key)
    const store = createTeamInviteIntentStore(storage, 'team-a', 'actor-a', newKey)
    const original = store.prepare(' Member@example.test ')
    store.noteReceipt(original.email, key, teamInvitationFixture())
    const reopened = createTeamInviteIntentStore(storage, 'team-a', 'actor-a', newKey)
    expect(reopened.active()).toMatchObject({ email: 'Member@example.test', idempotency_key: key,
      receipt: { operation_id: 'identity-operation-fixture', delivery: { operation_id: 'mail-operation-fixture' } } })
    expect(reopened.prepare('member@EXAMPLE.test').email).toBe('Member@example.test')
    expect(reopened.prepare('member@EXAMPLE.test').idempotency_key).toBe(key)
    expect(newKey).toHaveBeenCalledOnce()
    expect(JSON.stringify([...storage.values])).not.toContain(teamInvitationCapability)
    expect(JSON.stringify([...storage.values])).not.toContain('invitation_url')
  })
  it.each([true, false, null])('retains the original key for created=%s and never acknowledges an uncertain delivery', invitation_created => {
    const storage = memory(), newKey = vi.fn(() => key), store = createTeamInviteIntentStore(storage, 'team-a', 'actor-a', newKey)
    store.prepare('member@example.test'); store.noteReceipt('member@example.test', key, { ...unknown, invitation_created })
    store.acknowledge('member@example.test', key)
    expect(createTeamInviteIntentStore(storage, 'team-a', 'actor-a', newKey).active()?.idempotency_key).toBe(key)
    expect(store.prepare('member@example.test').idempotency_key).toBe(key)
    expect(newKey).toHaveBeenCalledOnce()
  })
  it('keeps another address as a separate command without replacing the uncertain original', () => {
    const storage = memory(), keys = [key, '00000000-0000-4000-8000-000000000002'], next = vi.fn(() => keys.shift()!)
    const store = createTeamInviteIntentStore(storage, 'team-a', 'actor-a', next)
    store.prepare('first@example.test'); store.noteReceipt('first@example.test', key, unknown)
    expect(store.prepare('second@example.test').idempotency_key).not.toBe(key)
    expect(store.prepare('first@example.test').idempotency_key).toBe(key)
    expect(next).toHaveBeenCalledTimes(2)
  })
  it('never restores another actor or team command', () => {
    const storage = memory(), store = createTeamInviteIntentStore(storage, 'team-a', 'actor-a', () => key)
    store.prepare('member@example.test')
    expect(createTeamInviteIntentStore(storage, 'team-b', 'actor-a').active()).toBeNull()
    expect(createTeamInviteIntentStore(storage, 'team-a', 'actor-b').active()).toBeNull()
    expect(store.active()?.idempotency_key).toBe(key)
  })
  it('refuses unavailable storage and corrupt commands before a replacement key can be created', () => {
    const storage = memory(), next = vi.fn(() => key), store = createTeamInviteIntentStore(storage, 'team-a', 'actor-a', next)
    store.prepare('member@example.test')
    const record = [...storage.values.keys()].find(name => !name.endsWith(':active'))!
    storage.values.set(record, 'corrupt')
    expect(() => store.prepare('member@example.test')).toThrow(expect.objectContaining({ code: 'invitation_storage_unavailable' }))
    expect(next).toHaveBeenCalledOnce()
    const blocked = createTeamInviteIntentStore({ ...storage, setItem() { throw new Error('quota') } }, 'team-b', 'actor-b', () => key)
    expect(() => blocked.prepare('member@example.test')).toThrow(expect.objectContaining({ code: 'invitation_storage_unavailable' }))
  })
  it('does not exchange either operation ID or erase a confirmed creation on a later refusal', () => {
    const storage = memory(), store = createTeamInviteIntentStore(storage, 'team-a', 'actor-a', () => key)
    store.prepare('member@example.test'); const receipt = teamInvitationFixture(); store.noteReceipt('member@example.test', key, receipt)
    expect(() => store.noteReceipt('member@example.test', key, { ...receipt, operation_id: 'other-operation' })).toThrow()
    expect(() => store.noteReceipt('member@example.test', key, { ...receipt, delivery: { ...receipt.delivery, operation_id: 'other-mail' } })).toThrow()
    store.noteReceipt('member@example.test', key, { ...unknown, invitation_created: false, delivery: { ...unknown.delivery, state: 'pending' } })
    expect(store.active()?.receipt).toMatchObject({ invitation_created: true, operation_id: receipt.operation_id, delivery: receipt.delivery })
  })
  it('clears only the active pointer after accepted, retaining the per-email replay command', () => {
    const storage = memory(), store = createTeamInviteIntentStore(storage, 'team-a', 'actor-a', () => key)
    store.prepare('member@example.test'); store.noteReceipt('member@example.test', key, teamInvitationFixture())
    store.acknowledge('member@example.test', key)
    expect(store.active()).toBeNull()
    expect(store.prepare('member@example.test').idempotency_key).toBe(key)
  })
})
