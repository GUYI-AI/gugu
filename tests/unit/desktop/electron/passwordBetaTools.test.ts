import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { GuguMcpContext } from '../../../../apps/desktop/electron/acp-engine-utils'

const handlers = vi.hoisted(() => new Map<string, (input: unknown, signal: AbortSignal) => Promise<unknown>>())
const ports = vi.hoisted(() => ({ list: vi.fn(), request: vi.fn(), start: vi.fn(), status: vi.fn(), save: vi.fn(), saveStatus: vi.fn() }))
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
    const fill = { credentialId, browserId: 'browser', url: 'https://example.com/login', fill: [{ field: '账号', into: '#account' }, { field: '密码', into: '#password' }] }
    const reply = await handlers.get('password_fill')!({ action: 'request', ...fill }, call.signal)
    call.abort()
    expect(ports.request).toHaveBeenCalledWith(context(), lifetime, fill)
    expect(ports.start).not.toHaveBeenCalled()
    expect(JSON.stringify(reply)).toContain('pending')
    expect(lifetime.aborted).toBe(false)
  })
  it('does not return secret-bearing native exceptions, causes or stacks', async () => {
    await register('beta')
    const canary = 'password-test-error-canary'
    ports.start.mockRejectedValue(new Error(canary, { cause: new Error(canary) }))
    const reply = await handlers.get('password_fill')!({ action: 'start', requestId }, new AbortController().signal)
    expect(JSON.stringify(reply)).not.toContain(canary)
    expect(JSON.stringify(reply)).toContain('unavailable')
  })
  it('uses separate explicit start and status actions', async () => {
    await register('beta')
    ports.status.mockResolvedValue({ status: 'approved' })
    await handlers.get('password_fill')!({ action: 'status', requestId }, new AbortController().signal)
    expect(ports.status).toHaveBeenCalledWith(context(), requestId)
    expect(ports.start).not.toHaveBeenCalled()
  })
  it('routes password_save requests without the action field and status by requestId', async () => {
    await register('beta')
    ports.save.mockResolvedValue({ status: 'pending', requestId })
    const input = { action: 'request', origin: 'https://github.com', account: 'dev@example.com', fields: [{ name: 'API Key', value: 'k' }] }
    const reply = await handlers.get('password_save')!(input, new AbortController().signal)
    expect(ports.save).toHaveBeenCalledWith(context(), { origin: 'https://github.com', account: 'dev@example.com', fields: [{ name: 'API Key', value: 'k' }] })
    expect(JSON.stringify(reply)).toContain('pending')
    ports.saveStatus.mockResolvedValue({ status: 'saved', credentialId })
    await handlers.get('password_save')!({ action: 'status', requestId }, new AbortController().signal)
    expect(ports.saveStatus).toHaveBeenCalledWith(context(), requestId)
  })
  it('posts the request card with the call signal; browserId may be left out', async () => {
    vi.stubGlobal('__GUGU_TIER__', 'beta')
    const { registerPasswordBetaTools } = await import('../../../../apps/desktop/electron/mcp/password-beta-tools')
    const runHostAction = vi.fn(async (_action: unknown, signal?: AbortSignal) => signal)
    const social = { kind: 'social', runHostAction } as unknown as GuguMcpContext
    registerPasswordBetaTools({} as McpServer, () => social, work => work, new AbortController().signal)
    const seen: unknown[] = []
    ports.request.mockImplementation(async (bound: { runHostAction: (action: unknown) => Promise<unknown> }) => { seen.push(await bound.runHostAction('card')); return { status: 'pending', requestId } })
    ports.save.mockImplementation(async (bound: { runHostAction: (action: unknown) => Promise<unknown> }) => { seen.push(await bound.runHostAction('card')); return { status: 'pending', requestId } })
    const login = new AbortController(), save = new AbortController()
    const input = { action: 'request', url: 'https://example.com/settings', fill: [{ field: 'API Key', into: '#key' }] }
    expect(JSON.stringify(await handlers.get('password_fill')!(input, login.signal))).toContain('pending')
    await handlers.get('password_save')!({ action: 'request', origin: 'https://example.com', password: 'p' }, save.signal)
    expect(seen).toEqual([login.signal, save.signal])
  })
  it('rejects mixed password_save arguments before reaching the vault', async () => {
    await register('beta')
    const reply = await handlers.get('password_save')!({ action: 'status', requestId, origin: 'https://github.com' }, new AbortController().signal) as { isError?: boolean }
    expect(reply.isError).toBe(true)
    expect(ports.save).not.toHaveBeenCalled()
    expect(ports.saveStatus).not.toHaveBeenCalled()
  })
  it('fills nothing it cannot: other surfaces are not available yet, and a request needs url and fill', async () => {
    await register('beta')
    const screen = await handlers.get('password_fill')!({ action: 'request', on: 'screen', url: 'https://example.com', fill: [{ field: '密码', into: 'x' }] }, new AbortController().signal)
    expect(JSON.stringify(screen)).toContain('not_available')
    const missing = await handlers.get('password_fill')!({ action: 'request', credentialId }, new AbortController().signal) as { isError?: boolean }
    expect(missing.isError).toBe(true)
    expect(ports.request).not.toHaveBeenCalled()
  })
})

