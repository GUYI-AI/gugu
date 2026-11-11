import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { GuguMcpContext } from '../../../../apps/desktop/electron/acp-engine-utils'

const ports = vi.hoisted(() => ({ list: vi.fn(), request: vi.fn(), start: vi.fn(), status: vi.fn() }))
vi.mock('../../../../apps/desktop/electron/password-vault/beta-runtime-port', () => ({ passwordBetaAgentPort: () => ports }))

async function withBetaClient(run: (client: Client) => Promise<void>) {
  vi.stubGlobal('__GUGU_TIER__', 'beta')
  const { createDesktopGuguMcpHost } = await import('../../../../apps/desktop/electron/acp-engine-utils')
  const host = createDesktopGuguMcpHost()
  const client = new Client({ name: 'beta-tool-schema-contract', version: '1' })
  const context: GuguMcpContext = {
    kind: 'social', expectedOwnerUserId: 'owner-schema-test', subjectId: 'agent-schema-test',
    supabaseUrl: 'https://supabase.example', anonKey: 'public-test-key', agentId: 'agent-schema-test',
    threadRootId: null, guguHome: '/tmp/gugu-beta-tool-schema-test', getAccessToken: async () => 'test-token',
    runSessionAction: async () => ({}), runExtensionAction: async () => ({}), runHostAction: async () => ({}),
  }
  try {
    await host.start()
    const grant = await host.grant('beta-schema', context)
    await client.connect(new StreamableHTTPClientTransport(new URL(grant.url), {
      requestInit: { headers: { Authorization: `Bearer ${grant.capability}` } },
    }))
    await run(client)
  } finally {
    await client.close()
    await host.dispose()
    vi.unstubAllGlobals()
    vi.resetModules()
    vi.resetAllMocks()
  }
}

it('publishes a complete Beta tools/list that the MCP SDK and object-only consumers accept', async () => {
  await withBetaClient(async client => {
    // Read the real wire result before the SDK's normal listTools validation can discard it.
    const raw = await client.request({ method: 'tools/list' }, z.unknown())
    const parsed = ListToolsResultSchema.safeParse(raw)
    expect(parsed.success ? [] : parsed.error.issues).toEqual([])
    if (!parsed.success) throw new Error('Beta tools/list violates the MCP SDK schema')
    expect(parsed.data.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['message_send', 'password_credentials', 'password_fill']))
    for (const tool of parsed.data.tools) {
      expect(tool.inputSchema.type, tool.name).toBe('object')
      for (const combinator of ['oneOf', 'anyOf', 'allOf']) expect(tool.inputSchema, `${tool.name}.${combinator}`).not.toHaveProperty(combinator)
    }
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(parsed.data.tools.map(tool => tool.name))
  })
})

it('validates every password_fill action before dispatch and preserves successful replies', async () => {
  await withBetaClient(async client => {
    const requestId = '11111111-1111-4111-8111-111111111111'
    const credentialId = '22222222-2222-4222-8222-222222222222'
    const request = { action: 'request', credentialId, browserId: 'browser', url: 'https://example.com/login',
      fill: [{ field: '账号', into: '#account' }, { field: '密码', into: '#password' }] }
    const badArguments = [
      { action: 'request' }, { action: 'start' }, { action: 'status' },
      { ...request, requestId }, { action: 'start', requestId, credentialId },
      { action: 'status', requestId, fill: request.fill },
      { ...request, fill: [] }, { ...request, fill: [{ field: '密码' }] }, { ...request, url: undefined },
      { ...request, confidentialValue: 'schema-error-canary' },
      { action: 'start', requestId: 'invalid-id' }, { action: 'approve', requestId },
    ]
    for (const args of badArguments) {
      const reply = await client.callTool({ name: 'password_fill', arguments: args })
      expect(reply.isError, JSON.stringify(args)).toBe(true)
      expect(JSON.stringify(reply)).not.toContain('schema-error-canary')
    }
    expect(ports.request).not.toHaveBeenCalled()
    expect(ports.start).not.toHaveBeenCalled()
    expect(ports.status).not.toHaveBeenCalled()
    const missing = await client.callTool({ name: 'password_fill', arguments: { action: 'request' } })
    expect(JSON.stringify(missing)).toContain('Invalid password_fill arguments')

    ports.request.mockResolvedValue({ status: 'pending', requestId })
    ports.status.mockResolvedValue({ status: 'approved' })
    ports.start.mockResolvedValue({ status: 'submitted_unconfirmed' })
    expect(JSON.stringify(await client.callTool({ name: 'password_fill', arguments: request }))).toContain('pending')
    expect(JSON.stringify(await client.callTool({ name: 'password_fill', arguments: { action: 'status', requestId } }))).toContain('approved')
    expect(JSON.stringify(await client.callTool({ name: 'password_fill', arguments: { action: 'start', requestId } }))).toContain('submitted_unconfirmed')
    for (const port of [ports.request, ports.status, ports.start]) expect(port).toHaveBeenCalledOnce()
  })
})
