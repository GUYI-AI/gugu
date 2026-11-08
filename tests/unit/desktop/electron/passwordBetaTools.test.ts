import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { GuguMcpContext } from '../../../../apps/desktop/electron/acp-engine-utils'

const handlers = vi.hoisted(() => new Map<string, (input: unknown, signal: AbortSignal) => Promise<unknown>>())
const ports = vi.hoisted(() => ({ list: vi.fn(), request: vi.fn(), start: vi.fn(), status: vi.fn() }))
vi.mock('../../../../apps/desktop/electron/mcp/register-gugu-tool.mjs', () => ({
  registerGuguTool: (_server: unknown, def: { name: string }, run: (input: unknown, signal: AbortSignal) => Promise<unknown>) => handlers.set(def.name, run),
}))
vi.mock('../../../../apps/desktop/electron/password-vault/beta-runtime-port', () => ({ passwordBetaAgentPort: () => ports }))
const context = () => ({ kind: 'session-only', nativeSessionId: 'native', expectedOwnerUserId: 'owner', subjectId: 'agent' }) as GuguMcpContext
const requestId = '11111111-1111-4111-8111-111111111111'
const credentialId = '22222222-2222-4222-8222-222222222222'
afterEach(() => { vi.resetAllMocks(); vi.resetModules(); vi.unstubAllGlobals(); handlers.clear() })

describe('Beta password MCP boundary', () => {
  async function register(tier: string) {
    vi.stubGlobal('__GUGU_TIER__', tier)
    const { registerPasswordBetaTools } = await import('../../../../apps/desktop/electron/mcp/password-beta-tools')
    const lifetime = new AbortController().signal
    registerPasswordBetaTools({} as McpServer, context, work => work, lifetime)
    return lifetime
  }
  it('registers no password entry in a production build', async () => {
    await register('production')
    expect(handlers.size).toBe(0)
  })
  it('returns pending without starting the login; keeps the grant lifetime after the request', async () => {
    const lifetime = await register('beta')
    ports.request.mockResolvedValue({ status: 'pending', requestId: 'request' })
    const call = new AbortController()
    const input = { action: 'request', credentialId, browserId: 'browser', loginUrl: 'https://example.com/login', selection: { form: 'form', account: '#account', password: '#password' } }
    const reply = await handlers.get('password_login')!(input, call.signal)
    call.abort()
    expect(ports.request).toHaveBeenCalledWith(context(), lifetime, input)
    expect(ports.start).not.toHaveBeenCalled()
    expect(JSON.stringify(reply)).toContain('pending')
    expect(lifetime.aborted).toBe(false)
  })
  it('does not return secret-bearing native exceptions, causes or stacks', async () => {
    await register('beta')
    const canary = 'password-test-error-canary'
    ports.start.mockRejectedValue(new Error(canary, { cause: new Error(canary) }))
    const reply = await handlers.get('password_login')!({ action: 'start', requestId }, new AbortController().signal)
    expect(JSON.stringify(reply)).not.toContain(canary)
    expect(JSON.stringify(reply)).toContain('unavailable')
  })
  it('uses separate explicit start and status actions', async () => {
    await register('beta')
    ports.status.mockResolvedValue({ status: 'approved' })
    await handlers.get('password_login')!({ action: 'status', requestId }, new AbortController().signal)
    expect(ports.status).toHaveBeenCalledWith(context(), requestId)
    expect(ports.start).not.toHaveBeenCalled()
  })
})
