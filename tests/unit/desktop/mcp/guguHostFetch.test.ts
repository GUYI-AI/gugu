import { afterEach, describe, expect, it, vi } from 'vitest'
import { installHostFetch } from '@gugu/core/shared/hostFetch'
// @ts-expect-error — MCP implementation is an untyped ESM module.
import { callTool, RpcTransportError } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

const chatId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const context = { supabaseUrl: 'https://cloud.example', anonKey: 'anon', agentId: 'agent-1', threadRootId: null, getAccessToken: async () => 'token' }

/** What each runtime throws when the host gets no answer: undici (Node) and Chromium's net.fetch (the desktop host). */
const UNREACHABLE = {
  undici: () => new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND cloud.example'), { code: 'ENOTFOUND' }) }),
  chromium: () => new Error('net::ERR_PROXY_CONNECTION_FAILED'),
}

afterEach(() => installHostFetch(globalThis.fetch))

describe('Gugu tools reach the cloud through the host fetch', () => {
  it('sends with the fetch the host installed, not the runtime global', async () => {
    const installed = vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }))
    const global = vi.spyOn(globalThis, 'fetch')
    installHostFetch(installed as typeof globalThis.fetch)
    await callTool(context, 'message_rules', { chat_id: chatId }).catch(() => undefined)
    expect(installed).toHaveBeenCalled()
    expect(String((installed.mock.calls[0] as unknown[])[0])).toMatch(/^https:\/\/cloud\.example\/rest\/v1\//)
    expect(global).not.toHaveBeenCalled()
    global.mockRestore()
  })

  it.each(Object.keys(UNREACHABLE) as (keyof typeof UNREACHABLE)[])('a %s request that got no answer says what to do, without the runtime cause', async (runtime) => {
    installHostFetch(vi.fn(async () => { throw UNREACHABLE[runtime]() }) as typeof globalThis.fetch)
    const error = await callTool(context, 'message_rules', { chat_id: chatId }).then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(RpcTransportError)
    expect((error as Error).message).toContain('检查网络或代理')
    expect((error as Error).message).not.toMatch(/fetch failed|ENOTFOUND|net::|RPC/)
  })
})
