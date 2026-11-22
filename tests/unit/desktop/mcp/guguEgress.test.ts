import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEgress, installEgress, runtimeEgress, type EgressBackend } from '@gugu/core/shared/egress'
// @ts-expect-error — MCP implementation is an untyped ESM module.
import { callTool, RpcTransportError } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

const chatId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const context = { supabaseUrl: 'https://cloud.example', anonKey: 'anon', agentId: 'agent-1', threadRootId: null, getAccessToken: async () => 'token' }

function backend(fetch: EgressBackend['fetch'], classify: EgressBackend['classify'] = () => 'connect'): EgressBackend {
  return { name: 'test', fetch, classify, webSocket: () => { throw new Error('no socket in this test') } }
}

afterEach(() => installEgress(runtimeEgress()))

describe('Gugu tools reach the cloud through the egress', () => {
  it('sends with the installed egress, not the runtime global', async () => {
    const sent = vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }))
    const global = vi.spyOn(globalThis, 'fetch')
    installEgress(createEgress(backend(sent)))
    await callTool(context, 'message_rules', { chat_id: chatId }).catch(() => undefined)
    expect(sent).toHaveBeenCalled()
    expect(String((sent.mock.calls[0] as unknown[])[0])).toMatch(/^https:\/\/cloud\.example\/rest\/v1\//)
    expect(global).not.toHaveBeenCalled()
    global.mockRestore()
  })

  it.each([
    ['connect', '检查网络或代理'],
    ['proxy-auth', '认证'],
    ['tls', '证书'],
  ] as const)('a request that got no answer (%s) says what to do, without the runtime cause', async (kind, words) => {
    installEgress(createEgress(backend(async () => { throw new Error('net::ERR_SOMETHING raw cause') }, () => kind)))
    const error = await callTool(context, 'message_rules', { chat_id: chatId }).then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(RpcTransportError)
    expect((error as Error).message).toContain(words)
    expect((error as Error).message).not.toMatch(/fetch failed|ENOTFOUND|net::|RPC/)
  })

  it('a proxy that wants credentials (407) is a proxy-auth failure, not an HTTP answer', async () => {
    installEgress(createEgress(backend(async () => new Response('', { status: 407 }))))
    const error = await callTool(context, 'message_rules', { chat_id: chatId }).then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(RpcTransportError)
    expect((error as Error).message).toContain('认证')
  })
})
