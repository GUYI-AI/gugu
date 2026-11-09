import { describe, expect, it, vi } from 'vitest'
import { createBetaPasswordAccess, type BetaPasswordContext, type BetaPasswordHost } from '../../../../apps/desktop/electron/permissions/password-beta-access'
import type { PasswordPermissionCheck, PasswordPermissionTarget } from '../../../../apps/desktop/electron/permissions/password-execution'
import { PasswordFeatureReadiness } from '../../../../apps/desktop/electron/permissions/password-readiness'
import { defaultPermissionPolicy } from '../../../../apps/desktop/electron/permissions/rules'
import type { CredentialUseBinding } from '../../../../apps/desktop/electron/session/main/core/browser/credential-use-contract'

const owner = '486803ee-2f3d-45d3-8e5e-03dd579e1c1a'
vi.hoisted(() => { Object.defineProperty(globalThis, '__GUGU_TIER__', { value: 'beta', writable: true, configurable: true }) })
const binding: CredentialUseBinding = { accountId: owner, installationId: 'installation', agentId: 'agent', sessionId: 'raw-session',
  requestId: 'request', useId: 'use', browserId: 'browser', loginSurfaceId: 'private', loginSurfaceEpoch: 'epoch',
  documentId: 'document', frameId: 'frame', formFingerprint: 'form', credentialId: 'credential', credentialVersion: '1',
  lockEpoch: 'lock', origin: 'https://login.example', operation: 'login-submit' }
const stages = ['request', 'before_fill', 'before_submit', 'before_handoff'] as const
function fixture() {
  const account = new AbortController(), grant = new AbortController()
  let reads = 0, current = true
  let target: PasswordPermissionTarget | CredentialUseBinding = { ...binding }
  const policy = defaultPermissionPolicy()
  const native: BetaPasswordContext = { context: { kind: 'session-only', expectedOwnerUserId: owner, subjectId: 'agent', grantKey: 'taskpage:foreign' },
    sessionId: 'raw-session', installationId: 'installation', deviceId: 'device', signal: grant.signal,
    assertCurrent() { if (!current) throw new Error('changed native context') } }
  const host: BetaPasswordHost = { signal: account.signal, toolScope: () => 'session-only',
    async readPolicy() { reads++; return policy } }
  const adapter = createBetaPasswordAccess(host)
  const input = (stage: PasswordPermissionCheck['stage']): PasswordPermissionCheck => {
    target = stage === 'request' ? Object.fromEntries(Object.entries(binding).filter(([key]) => !['requestId', 'useId'].includes(key))) as PasswordPermissionTarget : { ...binding }
    return { stage, target: { ...target } } as PasswordPermissionCheck
  }
  return { account, grant, native, host, adapter, input, policy,
    target: () => target, replaceTarget(value: typeof target) { target = value }, reads: () => reads,
    abortAccount() { account.abort() }, switchAccount() { native.context.expectedOwnerUserId = 'another-owner' }, invalidate() { current = false } }
}
const unavailable = { code: 'password_permission_unavailable', message: 'password_permission_unavailable' }

describe('build-channel password Beta access', () => {
  it('defaults both operations closed and leaves full production readiness closed', async () => {
    for (const operation of ['save', 'use'] as const) {
      expect((await createBetaPasswordAccess().acquireFeatureGuard(operation, new AbortController().signal)).status).toBe('unavailable')
      expect((await new PasswordFeatureReadiness().check(operation, new AbortController().signal)).status).toBe('unavailable')
    }
  })

  it.each(stages)('%s reads fresh policy but never grants approval or a submission claim', async stage => {
    const f = fixture(), check = f.input(stage), port = await f.adapter.createPermission(f.native, f.target)
    f.policy.user.rules.push({ id: 'allow', tool: '*', effect: 'allow' })
    const guard = await port.revalidate(check, new AbortController().signal)
    expect(guard.requiresPersonConfirmation).toBe(true)
    expect(Object.keys(guard).sort()).toEqual(['assertCurrent', 'requiresPersonConfirmation', 'signal'])
    guard.assertCurrent()
    expect(f.reads()).toBe(1)
    // grantKey deliberately differs: actor identity comes from raw native sessionId.
  })

  it('checks locked owner denial on a new stage after a previous eligible result', async () => {
    const f = fixture(), port = await f.adapter.createPermission(f.native, f.target)
    await port.revalidate(f.input('request'), new AbortController().signal)
    f.policy.user.rules.push({ id: 'deny', tool: 'password.use', effect: 'deny', locked: true })
    await expect(port.revalidate(f.input('before_submit'), new AbortController().signal)).rejects.toMatchObject({ code: 'password_permission_denied' })
    expect(f.reads()).toBe(2)
  })

  it('preserves the request target when the authority adds IDs but pins complete bindings at later stages', async () => {
    const f = fixture(), request = f.input('request'), port = await f.adapter.createPermission(f.native, f.target)
    const requestGuard = await port.revalidate(request, new AbortController().signal)
    f.replaceTarget({ ...binding })
    expect(requestGuard.assertCurrent()).toBeUndefined()
    const fillGuard = await port.revalidate(f.input('before_fill'), new AbortController().signal)
    fillGuard.assertCurrent()
    f.replaceTarget({ ...binding, useId: 'another-use' })
    expect(() => fillGuard.assertCurrent()).toThrow('password_permission_unavailable')
    f.replaceTarget({ ...binding, documentId: 'another-document' })
    expect(() => requestGuard.assertCurrent()).toThrow('password_permission_unavailable')
  })

  it.each(['abortAccount', 'switchAccount', 'invalidate'] as const)('rejects %s while the policy read is pending', async change => {
    const f = fixture(), check = f.input('before_fill')
    let resolve!: (value: typeof f.policy) => void, start!: () => void
    const started = new Promise<void>(yes => { start = yes })
    f.host.readPolicy = () => { start(); return new Promise(yes => { resolve = yes }) }
    const adapter = createBetaPasswordAccess(f.host), port = await adapter.createPermission(f.native, f.target)
    const result = port.revalidate(check, new AbortController().signal)
    await started
    f[change]()
    resolve(f.policy)
    await expect(result).rejects.toMatchObject(unavailable)
  })

  it.each(['account', 'grant'] as const)('aborts eligibility immediately on actual %s lifetime cancellation', async key => {
    const f = fixture(), port = await f.adapter.createPermission(f.native, f.target)
    const guard = await port.revalidate(f.input('before_handoff'), new AbortController().signal)
    f[key].abort()
    expect(guard.signal.aborted).toBe(true)
    expect(() => guard.assertCurrent()).toThrow('password_permission_unavailable')
  })

  it('keeps save/use eligibility tied to the actual account lifetime', async () => {
    const f = fixture()
    const result = await f.adapter.acquireFeatureGuard('save', new AbortController().signal)
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') throw new Error('expected Beta eligibility')
    f.account.abort()
    expect(() => result.assertCurrent()).toThrow('password_permission_unavailable')
    expect((await f.adapter.acquireFeatureGuard('use', new AbortController().signal)).status).toBe('unavailable')
  })

  it('requires the fixed native getter and catches post-read target changes', async () => {
    const f = fixture(), check = f.input('before_submit'), port = await f.adapter.createPermission(f.native, f.target)
    const guard = await port.revalidate(check, new AbortController().signal)
    f.replaceTarget({ ...binding, origin: 'https://changed.example' })
    expect(() => guard.assertCurrent()).toThrow('password_permission_unavailable')
  })

  it.each(['accountId', 'sessionId', 'installationId', 'agentId'] as const)('rejects a caller-supplied foreign %s', async field => {
    const f = fixture(), check = f.input('before_fill'), port = await f.adapter.createPermission(f.native, f.target)
    Object.assign(check.target, { [field]: 'foreign' })
    await expect(port.revalidate(check, new AbortController().signal)).rejects.toMatchObject(unavailable)
    expect(f.reads()).toBe(0)
  })

  it('sanitizes private provider failures and rejects asynchronous native assertions', async () => {
    const f = fixture(), check = f.input('request')
    f.host.readPolicy = async () => { throw new Error('PRIVATE_PASSWORD_CANARY') }
    const port = await createBetaPasswordAccess(f.host).createPermission(f.native, f.target)
    const error = await port.revalidate(check, new AbortController().signal).catch(value => value)
    expect(error).toMatchObject(unavailable)
    expect(String(error.stack)).not.toContain('PRIVATE_PASSWORD_CANARY')
    f.native.assertCurrent = async () => { throw new Error('PRIVATE_LATE_CANARY') }
    await expect(port.revalidate(check, new AbortController().signal)).rejects.toMatchObject(unavailable)
  })
})
