import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PasswordUiCommand, PasswordUiReply } from '../../../packages/core/src/shared/passwordBetaProtocol'
import { createPasswordCardKey, openPasswordCard, sealPasswordCard } from '../../../packages/core/src/shared/passwordCardCipher'
import { BetaPasswordSaves } from '../../../apps/desktop/electron/password-vault/beta-save'
import { passwordSaveCardHandler } from '../../../apps/desktop/electron/password-vault/save-card-host'
import { remotePasswordSaveCard } from '../../../apps/desktop/src/lib/passwordSaveCards'
vi.mock('../../../apps/desktop/src/lib/deviceRpc', () => ({ callDeviceRpc: vi.fn() }))
const owner = 'owner', caller = { agentId: 'agent', sessionId: 'session' }
const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).forEach(close => close()) })
async function fixture() {
  const saves = new BetaPasswordSaves({ deviceId: 'desktop', describe: () => ({ agentName: 'Helper', sessionTitle: 'Helper' }), changed() {}, deliver: async () => {} })
  const request = await saves.request(null, caller, 'https://example.com', undefined, { fields: [{ name: '手机号', value: '15500000000', secret: false }] })
  cleanup.push(() => saves.invalidate())
  let writes = 0
  const invoke = async (command: PasswordUiCommand): Promise<PasswordUiReply> => {
    if (command.type === 'save') await saves.saving(request.requestId, async () => { writes++; return { reference: { id: crypto.randomUUID() } } })
    if (command.type === 'reject-save') saves.reject(command.requestId)
    return { ok: true, snapshot: { items: [], saves: saves.pending(), outcomes: saves.outcomes(), approvals: [], candidates: [] },
      ...(command.type === 'save-draft' ? { draft: saves.draft(command.requestId) } : {}) }
  }
  const handler = passwordSaveCardHandler(async () => ({ ownerId: owner, saves, items: async () => [], invoke }))
  const wire: unknown[] = []
  const call = async (_device: string, payload: { requestId: string; sealed: string }) => {
    const reply = await handler(payload, { request: { user_id: owner } }); wire.push(payload, reply)
    if (!reply.result) throw new Error('unavailable')
    return reply.result
  }
  const ui = remotePasswordSaveCard(request.view, undefined, call)!
  cleanup.push(ui.subscribe(() => {}))
  return { saves, request, handler, wire, ui, writes: () => writes }
}
describe('encrypted remote save cards', () => {
  it('opens the proposed value on the person UI while relay payloads contain ciphertext only', async () => {
    const f = await fixture(), reply = await f.ui.invoke({ type: 'save-draft', requestId: f.request.requestId })
    expect(reply.ok && reply.draft?.fields[0].value).toBe('15500000000')
    expect(JSON.stringify(f.wire)).not.toContain('15500000000')
    expect(JSON.stringify(f.request.view)).not.toContain('15500000000')
  })
  it('reads a new proposal without opening system password storage', async () => {
    const f = await fixture()
    const handler = passwordSaveCardHandler(async () => ({ ownerId: owner, saves: f.saves,
      items: async () => { throw new Error('system storage unavailable') }, invoke: async () => ({ ok: false, code: 'SYSTEM_STORAGE_UNAVAILABLE' }) }))
    const key = await createPasswordCardKey(), nonce = crypto.randomUUID()
    const sealed = await sealPasswordCard(f.request.view.saveKey!, { requestId: f.request.requestId, nonce, replyKey: key.publicKey,
      command: { type: 'save-draft', requestId: f.request.requestId } })
    const reply = await handler({ requestId: f.request.requestId, sealed }, { request: { user_id: owner } })
    expect(reply.result).toBeDefined()
    expect(await openPasswordCard(key, reply.result!.sealed)).toMatchObject({ reply: { ok: true, draft: { fields: [{ value: '15500000000' }] } } })
    key.privateKey.fill(0)
  })
  it('saves once, then reports the completed outcome on another refresh', async () => {
    const f = await fixture(), draft = f.saves.draft(f.request.requestId)
    const command = { type: 'save' as const, requestId: f.request.requestId, origin: draft.origin, account: '', password: '', fields: draft.fields }
    expect((await f.ui.invoke(command)).ok).toBe(true)
    await expect(f.ui.invoke(command)).rejects.toThrow()
    expect(f.writes()).toBe(1)
    expect(await f.ui.invoke({ type: 'snapshot' })).toMatchObject({ ok: true, snapshot: { saves: [], outcomes: [{ result: 'saved' }] } })
  })
  it('rejects another account and tampered or cross-request ciphertext before invoking a command', async () => {
    const f = await fixture(), key = await createPasswordCardKey()
    const seal = (requestId: string) => sealPasswordCard(f.request.view.saveKey!, { requestId, nonce: crypto.randomUUID(), replyKey: key.publicKey, command: { type: 'snapshot' } })
    const sealed = await seal(f.request.requestId)
    expect(await f.handler({ requestId: f.request.requestId, sealed }, { request: { user_id: 'other' } })).toHaveProperty('error')
    expect(await f.handler({ requestId: f.request.requestId, sealed: sealed.slice(1) }, { request: { user_id: owner } })).toHaveProperty('error')
    expect(await f.handler({ requestId: f.request.requestId, sealed: await seal(crypto.randomUUID()) }, { request: { user_id: owner } })).toHaveProperty('error')
    key.privateKey.fill(0); expect(f.writes()).toBe(0)
  })
  it('rejects vault enumeration and revealing a stored secret over the card endpoint', async () => {
    const f = await fixture(), key = await createPasswordCardKey()
    const sealed = await sealPasswordCard(f.request.view.saveKey!, { requestId: f.request.requestId, nonce: crypto.randomUUID(), replyKey: key.publicKey,
      command: { type: 'reveal', reference: { id: crypto.randomUUID(), version: 1, epoch: 'e' } } })
    expect(await f.handler({ requestId: f.request.requestId, sealed }, { request: { user_id: owner } })).toHaveProperty('error')
    key.privateKey.fill(0)
  })
  it('does not allow a second save or rejection while the first save is in flight', async () => {
    const f = await fixture()
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const saving = f.saves.saving(f.request.requestId, async () => { await waiting; return { reference: { id: crypto.randomUUID() } } })
    await expect(f.saves.saving(f.request.requestId, async () => ({ reference: { id: crypto.randomUUID() } }))).rejects.toMatchObject({ code: 'REQUEST_PENDING' })
    expect(() => f.saves.reject(f.request.requestId)).toThrow()
    release(); await saving
  })
  it('a different ephemeral key cannot open a reply', async () => {
    const first = await createPasswordCardKey(), other = await createPasswordCardKey()
    await expect(openPasswordCard(other, await sealPasswordCard(first.publicKey, { value: 'synthetic-test-value' }))).rejects.toThrow()
    first.privateKey.fill(0); other.privateKey.fill(0)
  })
})
