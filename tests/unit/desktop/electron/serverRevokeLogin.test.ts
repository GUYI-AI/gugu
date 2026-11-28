import { describe, expect, it, vi } from 'vitest'
import { revokeServerLogin } from '../../../../apps/desktop/electron/server/server-revoke-login'

vi.mock('../../../../apps/desktop/electron/server/server-auth', () => ({
  clearStoredServerSession: vi.fn(),
  readStoredServerSession: vi.fn(),
  reserveSessionSlot: vi.fn(),
  writeStoredServerSession: vi.fn(),
}))

const owner = 'owner'
const session = '11111111-1111-4111-8111-111111111111'
const access = (exp: number, sessionId = session) =>
  ['header', Buffer.from(JSON.stringify({ sub: owner, session_id: sessionId, exp })).toString('base64url'), 'signature'].join('.')
const original = { accessToken: access(1), refreshToken: 'old refresh' }
const rotated = { accessToken: access(2), refreshToken: 'new refresh' }
const logoutPath = 'logout?scope=local'
const tokenPath = 'token?grant_type=refresh_token'
const rejection = (status: number, error_code: string) => Response.json({ error_code }, { status })

function store(request: Parameters<typeof revokeServerLogin>[1]['request']) {
  let current: typeof original | null = original
  return {
    read: () => current,
    reserve: vi.fn(),
    write: vi.fn((tokens: typeof original) => { current = tokens }),
    clear: vi.fn(() => { current = null }),
    request: vi.fn(request),
  }
}

describe('revoking an installed server login', () => {
  it('retries session-scoped logout after a committed revocation lost its response', async () => {
    let live = true
    const deps = store(async (path, headers) => {
      expect(path).toBe(logoutPath)
      expect(headers.authorization).toBe('Bearer ' + original.accessToken)
      if (!live) return rejection(403, 'session_not_found')
      live = false
      throw new Error('Connection closed without a response')
    })
    await expect(revokeServerLogin(owner, deps)).rejects.toThrow('Connection closed')
    expect(deps.read()).toEqual(original)
    expect(deps.clear).not.toHaveBeenCalled()
    await revokeServerLogin(owner, deps)
    expect(deps.read()).toBeNull()
    expect(deps.reserve).not.toHaveBeenCalled()
  })

  it('persists both rotated tokens before logout, retaining them if logout fails', async () => {
    const deps = store(async (path, headers) => {
      if (path === tokenPath) {
        expect(deps.reserve).toHaveBeenCalledOnce()
        return Response.json({ access_token: rotated.accessToken, refresh_token: rotated.refreshToken })
      }
      if (headers.authorization === 'Bearer ' + original.accessToken) return rejection(403, 'bad_jwt')
      expect(deps.read()).toEqual(rotated)
      return deps.request.mock.calls.length === 3 ? rejection(502, 'unexpected_failure') : new Response(null, { status: 204 })
    })
    await expect(revokeServerLogin(owner, deps)).rejects.toThrow('HTTP 502')
    expect(deps.read()).toEqual(rotated)
    expect(deps.clear).not.toHaveBeenCalled()
    await revokeServerLogin(owner, deps)
    expect(deps.read()).toBeNull()
    expect(deps.write).toHaveBeenCalledOnce()
  })

  it('keeps the login when a refresh token is rejected without evidence about the session', async () => {
    const deps = store(async path => path === logoutPath ? rejection(403, 'bad_jwt') : rejection(400, 'refresh_token_not_found'))
    await expect(revokeServerLogin(owner, deps)).rejects.toThrow('Could not refresh')
    expect(deps.read()).toEqual(original)
    expect(deps.clear).not.toHaveBeenCalled()
  })

  it('does not send logout for an access token without a bound session', async () => {
    const deps = store(async () => new Response(null, { status: 204 }))
    deps.write({ ...original, accessToken: access(1, '') })
    await expect(revokeServerLogin(owner, deps)).rejects.toThrow('does not identify')
    expect(deps.request).not.toHaveBeenCalled()
  })
})
