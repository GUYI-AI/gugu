import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GuguMcpContext } from '../../../apps/desktop/electron/acp-engine-utils'
import { BetaPasswordSaves } from '../../../apps/desktop/electron/password-vault/beta-save'
import { PASSWORD_REQUEST_PREFIX, passwordGrantLevel, type PasswordItem } from '../../../packages/core/src/shared/passwordBetaProtocol'

const posted: string[] = []
const context = (sent = true) => ({ kind: 'social', agentId: 'agent-1',
  runHostAction: async (action: { request_id: string; text: string }) => { posted.push(action.text); return sent ? { status: 'sent', message_id: action.request_id } : { status: 'failed' } },
}) as unknown as GuguMcpContext
const caller = { agentId: 'agent-1', sessionId: 'session-1' }
function saves() {
  const deliver = vi.fn(async (_session: string, _request: string, _status: string, _credential?: string) => {}), changed = vi.fn()
  const value = new BetaPasswordSaves({ deviceId: 'device-1', changed, deliver, describe: () => ({ agentName: '研究助理', sessionTitle: '注册账号' }) })
  return { value, deliver, changed }
}
const item: PasswordItem = { reference: { id: '22222222-2222-4222-8222-222222222222', version: 3, epoch: 'e' }, origin: 'https://github.com', name: '',
  maskedAccount: 'd***@example.com', accountSecret: false, hasPassword: true, fields: [{ id: '33333333-3333-4333-8333-333333333333', name: 'API Key', secret: true }], grants: [], sites: [] }
afterEach(() => { posted.length = 0; vi.useRealTimers() })

describe('Agent save requests', () => {
  it('posts metadata only; the proposed values reach only the person draft', async () => {
    const { value } = saves()
    const reply = await value.request(context(), caller, 'https://github.com', undefined, { account: 'dev@example.com', password: 'canary-secret', fields: [{ name: 'API Key', value: 'canary-key' }] })
    expect(reply.status).toBe('pending')
    expect(posted).toHaveLength(1)
    expect(posted[0].startsWith(PASSWORD_REQUEST_PREFIX)).toBe(true)
    expect(posted[0]).not.toContain('canary')
    expect(posted[0]).not.toContain('dev@example.com')
    // The card shows the proposed account the way every stored account is shown: masked.
    expect(JSON.parse(posted[0].slice(PASSWORD_REQUEST_PREFIX.length))).toMatchObject({ kind: 'save', origin: 'https://github.com', agentName: '研究助理', maskedAccount: 'd***@example.com' })
    expect(value.pending().map(request => request.requestId)).toEqual([reply.requestId])
    expect(value.draft(reply.requestId)).toMatchObject({ account: 'dev@example.com', password: 'canary-secret', fields: [{ name: 'API Key', value: 'canary-key' }] })
  })
  it('edits keep the stored field ids so blank values keep stored ones', async () => {
    const { value } = saves()
    const reply = await value.request(context(), caller, item.origin, item, { fields: [{ name: 'API Key', value: 'new-key' }] })
    const draft = value.draft(reply.requestId)
    expect(draft.credentialId).toBe(item.reference.id)
    expect(draft.fields[0].id).toBe(item.fields[0].id)
    expect(posted[0]).toContain('d***@example.com')
  })
  it('allows one open request per session', async () => {
    const { value } = saves()
    await value.request(context(), caller, 'https://github.com', undefined, {})
    await expect(value.request(context(), caller, 'https://gitlab.com', undefined, {})).rejects.toThrow()
    await expect(value.request(context(), { ...caller, sessionId: 'session-2' }, 'https://gitlab.com', undefined, {})).resolves.toMatchObject({ status: 'pending' })
  })
  it('completing wipes the proposal and tells the Agent only the outcome', async () => {
    const { value, deliver } = saves()
    const reply = await value.request(context(), caller, 'https://github.com', undefined, { password: 'canary-secret' })
    const pending = value.open(reply.requestId)
    value.complete(reply.requestId, item.reference.id)
    expect(pending.draft.password).toBe('')
    expect(deliver).toHaveBeenCalledWith('session-1', reply.requestId, 'saved', item.reference.id)
    expect(value.status(reply.requestId, 'session-1')).toEqual({ status: 'saved', credentialId: item.reference.id })
    expect(() => value.draft(reply.requestId)).toThrow()
    expect(() => value.status(reply.requestId, 'session-2')).toThrow()
  })
  it('reject, expiry and invalidation each end the request once', async () => {
    vi.useFakeTimers()
    const { value, deliver } = saves()
    const rejected = await value.request(context(), caller, 'https://a.example', undefined, {})
    value.reject(rejected.requestId)
    expect(() => value.reject(rejected.requestId)).toThrow()
    const expired = await value.request(context(), caller, 'https://b.example', undefined, {})
    vi.advanceTimersByTime(30 * 60_000 + 1)
    const invalidated = await value.request(context(), caller, 'https://c.example', undefined, {})
    value.invalidate()
    expect(deliver.mock.calls.map(call => [call[1], call[2]])).toEqual([
      [rejected.requestId, 'rejected'], [expired.requestId, 'expired'], [invalidated.requestId, 'invalidated']])
    expect(value.pending()).toEqual([])
  })
  it('a request whose message was not sent leaves nothing pending', async () => {
    const { value } = saves()
    await expect(value.request(context(false), caller, 'https://github.com', undefined, { password: 'canary-secret' })).rejects.toThrow()
    expect(value.pending()).toEqual([])
  })
})

describe('grant level for a caller', () => {
  it('takes the strongest of the Agent and its project; unlisted callers ask', () => {
    const grants = [{ subject: 'project:p', level: 'read' as const }, { subject: 'agent:a', level: 'write' as const }]
    expect(passwordGrantLevel(grants, ['agent:a', 'project:p'])).toBe('write')
    expect(passwordGrantLevel(grants, ['agent:b', 'project:p'])).toBe('read')
    expect(passwordGrantLevel([...grants].reverse(), ['agent:a', 'project:p'])).toBe('write')
    expect(passwordGrantLevel(grants, ['agent:b', 'project:q'])).toBeUndefined()
  })
})
