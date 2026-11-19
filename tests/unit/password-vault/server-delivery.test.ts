import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GuguMcpContext } from '../../../apps/desktop/electron/acp-engine-utils'
import { BetaRemoteLogins } from '../../../apps/desktop/electron/password-vault/beta-remote'
import { createServerPasswordAgent, type ServerPasswordHost } from '../../../apps/desktop/electron/password-vault/server-agent'
import { remoteOpSchema, serverDeliveryKey, type RemoteCaller, type RemoteOp } from '../../../apps/desktop/electron/password-vault/server-delivery'
import { sealTo } from '../../../apps/desktop/electron/password-vault/sync-crypto'
import type { PasswordItem } from '../../../packages/core/src/shared/passwordBetaProtocol'

const agentId = '11111111-1111-4111-8111-111111111111', owner = '99999999-9999-4999-8999-999999999999'
const caller: RemoteCaller = { deviceId: '77777777-7777-4777-8777-777777777777', sessionId: '66666666-6666-4666-8666-666666666661', agentId, agentName: '研究助理', sessionTitle: '登录' }
const item: PasswordItem = { reference: { id: '22222222-2222-4222-8222-222222222222', version: 1, epoch: 'e' }, origin: 'https://site.example', name: '',
  maskedAccount: 't***', accountSecret: false, hasPassword: true, fields: [], grants: [], sites: [] }
afterEach(() => { vi.useRealTimers() })

describe('「本机送」 on the desktop: requests from a server', () => {
  const logins = () => new BetaRemoteLogins({ deviceId: 'mac-1', changed: () => {} })
  it('a granted request is approved at once, released once, and only to the session that asked', async () => {
    const remote = logins()
    const { requestId, status, view } = remote.request(caller, item, true)
    expect(status).toBe('approved')
    expect(view).toMatchObject({ deviceId: 'mac-1', origin: item.origin, maskedAccount: 't***', agentName: '研究助理' })
    await expect(remote.release(requestId, { ...caller, sessionId: '66666666-6666-4666-8666-666666666662' }, async () => 'sealed')).rejects.toThrow()
    expect(await remote.release(requestId, caller, async () => 'sealed')).toBe('sealed')
    await expect(remote.release(requestId, caller, async () => 'again')).rejects.toThrow()
    expect(remote.status(requestId, caller)).toBe('used')
  })
  it('without a grant it waits for the card; 拒绝 ends it, 允许 lets one use through', async () => {
    const remote = logins()
    const first = remote.request(caller, item, false)
    expect(first.status).toBe('pending')
    expect(remote.pending().map(view => view.requestId)).toEqual([first.requestId])
    await expect(remote.release(first.requestId, caller, async () => 'x')).rejects.toThrow()
    remote.decide(first.requestId, 'reject')
    expect(remote.status(first.requestId, caller)).toBe('rejected')
    const second = remote.request(caller, item, false)
    remote.decide(second.requestId, 'allow_once')
    expect(await remote.release(second.requestId, caller, async () => 'sealed')).toBe('sealed')
  })
  it('one open request per server session, and unanswered requests expire', () => {
    vi.useFakeTimers()
    const remote = logins()
    const { requestId } = remote.request(caller, item, false)
    expect(() => remote.request(caller, item, false)).toThrow()
    expect(() => remote.request({ ...caller, sessionId: '66666666-6666-4666-8666-666666666662' }, item, false)).not.toThrow()
    vi.advanceTimersByTime(11 * 60_000)
    expect(remote.status(requestId, caller)).toBe('expired')
    expect(remote.pending()).toEqual([])
  })
})

describe('「本机送」 on the server: the password tools ask the desktop', () => {
  let home: string | undefined
  afterEach(async () => { if (home) await rm(home, { recursive: true, force: true }); home = undefined })
  function server(desktop: (op: RemoteOp) => unknown, extra: Partial<ServerPasswordHost> = {}) {
    const posted: string[] = [], delivered: string[] = []
    const context = { kind: 'social', expectedOwnerUserId: owner, subjectId: agentId, nativeSessionId: '66666666-6666-4666-8666-666666666661', agentId,
      runHostAction: async (action: { request_id: string; text: string }) => { posted.push(action.text); return { status: 'sent', message_id: action.request_id } } } as unknown as GuguMcpContext
    const calls: string[] = []
    const host: ServerPasswordHost = {
      ownerId: async () => owner, thisDevice: async () => '77777777-7777-4777-8777-777777777777', desktops: async () => ['old-laptop', 'mac-1'],
      call: async (device, payload) => {
        calls.push(`${device}:${payload.op}`)
        expect(remoteOpSchema.safeParse(payload).success).toBe(true)
        if (device !== 'mac-1') return { error: { code: 'PASSWORD_UNAVAILABLE' } }
        return { result: await desktop(payload) }
      },
      describe: () => ({ agentName: '研究助理', sessionTitle: '登录' }),
      deliver: async (_session, requestId, status) => { delivered.push(`${requestId}:${status}`) },
      deliverSave: async () => {},
      home: () => home!,
      privateLogin: vi.fn(async () => ({ status: 'submitted_unconfirmed', cookies: 2 })),
      ...extra,
    }
    return { agent: createServerPasswordAgent(host), context, posted, delivered, calls, host }
  }
  const fill = { form: '#login', submit: '#go', fill: [{ field: '账号', into: '#user' }, { field: '密码', into: '#pass' }] }
const selection = { form: '#login', account: '#user', password: '#pass', submitter: '#go' }

  it('finds the desktop that keeps the vault, posts the card from its own session, and tells the session the answer', async () => {
    home = await mkdtemp(path.join(tmpdir(), 'server-home-'))
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let answer = 'pending'
    const { agent, context, posted, delivered, calls } = server(op => op.op === 'request'
      ? { requestId: '33333333-3333-4333-8333-333333333333', status: 'pending', view: { kind: 'login', requestId: '33333333-3333-4333-8333-333333333333' } }
      : { status: answer })
    const reply = await agent.request(context, new AbortController().signal, { credentialId: item.reference.id, url: 'https://site.example/login', ...fill })
    expect(reply).toEqual({ requestId: '33333333-3333-4333-8333-333333333333', status: 'pending' })
    expect(calls.slice(0, 2)).toEqual(['old-laptop:request', 'mac-1:request'])
    expect(posted).toHaveLength(1)
    answer = 'approved'
    await vi.advanceTimersByTimeAsync(3_100)
    expect(delivered).toEqual(['33333333-3333-4333-8333-333333333333:approved'])
  })

  it('start opens what the desktop sealed to this server, logs in privately, and returns only the status', async () => {
    home = await mkdtemp(path.join(tmpdir(), 'server-home-'))
    const requestId = '44444444-4444-4444-8444-444444444444'
    const { agent, context, host } = server(async op => {
      if (op.op === 'request') return { requestId, status: 'approved', view: {} }
      if (op.op === 'release') return { sealed: await sealTo(op.serverKey, Buffer.from(JSON.stringify({ account: 'tomsmith', password: 'canary-pass' }))) }
      return { status: 'approved' }
    })
    await agent.request(context, new AbortController().signal, { credentialId: item.reference.id, url: 'https://site.example/login', ...fill })
    const result = await agent.start(context, requestId)
    expect(result).toEqual({ status: 'submitted_unconfirmed' })
    expect(JSON.stringify(result)).not.toContain('canary')
    expect(host.privateLogin).toHaveBeenCalledWith('66666666-6666-4666-8666-666666666661', expect.objectContaining({ origin: 'https://site.example', selection, account: 'tomsmith', password: 'canary-pass' }))
    // Used once: a second start has nothing to release.
    await expect(agent.start(context, requestId)).rejects.toThrow()
    // The delivery key stays on this server, private.
    expect((await stat(path.join(home, 'password-delivery-key'))).mode & 0o777).toBe(0o600)
    expect((await serverDeliveryKey(home)).publicKey).toBe((await serverDeliveryKey(home)).publicKey)
  })

  it('refuses a request that is not https, and another session’s request', async () => {
    home = await mkdtemp(path.join(tmpdir(), 'server-home-'))
    const { agent, context } = server(() => ({ requestId: '55555555-5555-4555-8555-555555555555', status: 'approved', view: {} }))
    await expect(agent.request(context, new AbortController().signal, { credentialId: item.reference.id, url: 'http://site.example/login', ...fill })).rejects.toThrow()
    await agent.request(context, new AbortController().signal, { credentialId: item.reference.id, url: 'https://site.example/login', ...fill })
    // A server's browser takes logins only for now: anything else is refused before the desktop is asked.
    expect(await agent.request(context, new AbortController().signal, { credentialId: item.reference.id, url: 'https://site.example/settings',
      fill: [{ field: 'API Key', into: '#key' }], submit: '#save' })).toMatchObject({ status: 'invalid_request' })
    const other = { ...context, nativeSessionId: '66666666-6666-4666-8666-666666666662' } as GuguMcpContext
    await expect(agent.start(other, '55555555-5555-4555-8555-555555555555')).rejects.toThrow()
  })
})
