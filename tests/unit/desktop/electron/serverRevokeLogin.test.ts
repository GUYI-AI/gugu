import { describe, expect, it, vi } from 'vitest'
import { revokeServerLogin } from '../../../../apps/desktop/electron/server/server-revoke-login'

vi.mock('../../../../apps/desktop/electron/server/server-auth', () => ({
  clearStoredServerSession: vi.fn(),
  readStoredServerSession: vi.fn(),
}))

const owner = 'owner'
const session = '11111111-1111-4111-8111-111111111111'
const access = (exp: number, sessionId = session) =>
  ['header', Buffer.from(JSON.stringify({ sub: owner, session_id: sessionId, exp })).toString('base64url'), 'signature'].join('.')
const original = { accessToken: access(1), refreshToken: 'old refresh' }
const rotated = { accessToken: access(2), refreshToken: 'new refresh' }

function store(current: typeof original | null = original, receipt = owner + '\n') {
  const deps = {
    receipt,
    read: vi.fn(() => current),
    markRevoked: vi.fn((text: string) => { deps.receipt = text }),
    clear: vi.fn(() => { current = null }),
  }
  return deps
}

describe('revoking an installed server login', () => {
  it('reports the exact session of an expired credential and waits for the desktop receipt', async () => {
    const deps = store()
    await expect(revokeServerLogin(owner, deps)).resolves.toBe(session)
    expect(deps.read()).toEqual(original)
    expect(deps.clear).not.toHaveBeenCalled()
    await revokeServerLogin(owner, deps, session)
    expect(deps.markRevoked).toHaveBeenCalledWith(`${owner}\n${session}\n`)
    expect(deps.read()).toBeNull()
  })

  it('a rotated credential has the same binding and is retained until revocation is confirmed', async () => {
    const deps = store(rotated)
    await expect(revokeServerLogin(owner, deps)).resolves.toBe(session)
    expect(deps.read()).toEqual(rotated)
    expect(deps.markRevoked).not.toHaveBeenCalled()
    expect(deps.clear).not.toHaveBeenCalled()
  })

  it('can resume after local clearing and refuses a receipt for an earlier login', async () => {
    const receipt = `${owner}\n${session}\n`
    const cleared = store(null, receipt)
    await expect(revokeServerLogin(owner, cleared, session)).resolves.toBe(session)
    expect(cleared.markRevoked).not.toHaveBeenCalled()
    const current = store({ ...original, accessToken: access(3, '22222222-2222-4222-8222-222222222222') }, receipt)
    await expect(revokeServerLogin(owner, current, session)).rejects.toThrow('account changed')
    expect(current.clear).not.toHaveBeenCalled()
  })

  it('does not clear credentials without a bound session', async () => {
    const deps = store({ ...original, accessToken: access(1, '') })
    await expect(revokeServerLogin(owner, deps)).rejects.toThrow('does not identify')
    expect(deps.clear).not.toHaveBeenCalled()
  })
})
