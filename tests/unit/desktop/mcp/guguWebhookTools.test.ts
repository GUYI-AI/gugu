// #3934 The webhook tool an owner or admin Agent uses (owner 11-26 21:39): the same six database functions as the app,
// acting as the session's own Agent. The list carries no address; create, address and rotate return it.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import { registerGuguCatalogTools } from '../../../../apps/desktop/electron/mcp/gugu-catalog-tools'
// @ts-expect-error — the injected MCP server is an untyped .mjs; the runtime import works.
import { callTool as callToolImpl, createGuguImServer } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

const CONTEXT = {
  supabaseUrl: 'https://db.example.test', anonKey: '', agentId: 'agent-1', threadRootId: null,
  guguHome: '/tmp/gugu-im-test', getAccessToken: async () => '',
}
const GROUP = 'c0000000-0000-4000-8000-000000000001'
const HOOK = 'b0000000-0000-4000-8000-000000000002'
const MEMBER = 'a0000000-0000-4000-8000-000000000003'
const TOKEN = 'ggwh_' + 'Q'.repeat(40)
const ROW = {
  id: HOOK, chat_id: GROUP, name: '部署告警', token: TOKEN, target_user_ids: [MEMBER], created_by: 'agent-1',
  created_by_name: '管家', created_at: '2026-11-27T00:00:00Z', disabled_at: null, last_used_at: null,
}

function harness(rows: unknown[] = [ROW]) {
  const calls: Array<[string, Record<string, unknown>]> = []
  const restRpc = async (name: string, body: Record<string, unknown>) => { calls.push([name, body]); return rows }
  const call = async (action: string, args: Record<string, unknown>) => JSON.parse(String(await callToolImpl(CONTEXT, 'group_webhook', { action, ...args }, { restRpc })))
  return { calls, call }
}
const ADDRESS = `https://db.example.test/functions/v1/group-webhook/${TOKEN}`

describe('group_webhook', () => {
  it.each([
    ['list', {}, /list:.*chat_id/],
    ['create', { chat_id: GROUP }, /create:.*name/],
    ['update', { webhook_id: HOOK }, /update:.*name, targets/],
    ['address', { chat_id: GROUP }, /address:.*webhook_id/],
    ['rotate', { webhook_id: HOOK, disabled: true }, /rotate:.*disabled/],
    ['disable', { webhook_id: HOOK }, /disable:.*disabled/],
  ] as const)('rejects invalid %s arguments before any RPC', async (action, args, error) => {
    const h = harness()
    await expect(h.call(action, args)).rejects.toThrow(error)
    expect(h.calls).toEqual([])
  })

  it('reports invalid actions and fields through both registered MCP entry points', async () => {
    const restRpc = vi.fn()
    const server = createGuguImServer(() => CONTEXT, { restRpc, trackRequest: (work: Promise<unknown>) => work })
    registerGuguCatalogTools(server, () => [])
    const client = new Client({ name: 'webhook-test', version: '1' })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await Promise.all([client.connect(clientSide), server.connect(serverSide)])
    try {
      for (const name of ['group_webhook', 'catalog_call']) {
        for (const [args, error] of [
          [{ action: 'delete', webhook_id: 'bad' }, /group_webhook delete:.*webhook_id:.*uuid/i],
          [{ action: 'unknown' }, /group_webhook:.*action:.*list.*delete/i],
        ] as const) {
          const result = await client.callTool({ name, arguments: name === 'catalog_call' ? { tool: 'group_webhook', args } : args })
          expect(result.isError).toBe(true)
          expect(result.content).toEqual([expect.objectContaining({ type: 'text', text: expect.stringMatching(error) })])
        }
      }
      expect(restRpc).not.toHaveBeenCalled()
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('lists without addresses, acting as the session’s Agent', async () => {
    const h = harness()
    const listed = await h.call('list', { chat_id: GROUP })
    expect(listed).toEqual([{ webhook_id: HOOK, chat_id: GROUP, name: '部署告警', targets: [`user:${MEMBER}`], enabled: true,
      created_by: 'user:agent-1', created_by_name: '管家', created_at: ROW.created_at, last_used_at: null }])
    expect(JSON.stringify(listed)).not.toContain(TOKEN)
    expect(h.calls).toEqual([['group_webhooks_list', { p_chat_id: GROUP, p_as_user_id: 'agent-1' }]])
  })

  it('create returns the address; targets are typed addresses resolved to members', async () => {
    const h = harness()
    const created = await h.call('create', { chat_id: GROUP, name: '部署告警', targets: [`user:${MEMBER}`] })
    expect(created).toMatchObject({ webhook_id: HOOK, address: ADDRESS, slack_address: `${ADDRESS}/slack`, targets: [`user:${MEMBER}`] })
    const untargeted = await h.call('create', { chat_id: GROUP, name: 'CI' })
    expect(untargeted.address).toBe(ADDRESS)
    expect(h.calls).toEqual([
      ['group_webhook_create', { p_chat_id: GROUP, p_name: '部署告警', p_target_user_ids: [MEMBER], p_as_user_id: 'agent-1' }],
      ['group_webhook_create', { p_chat_id: GROUP, p_name: 'CI', p_target_user_ids: [], p_as_user_id: 'agent-1' }],
    ])
  })

  it('reads one address by name of its webhook; an unknown one is an error, not an empty answer', async () => {
    const h = harness()
    expect((await h.call('address', { chat_id: GROUP, webhook_id: HOOK })).address).toBe(ADDRESS)
    await expect(h.call('address', { chat_id: GROUP, webhook_id: 'b0000000-0000-4000-8000-0000000000ff' }))
      .rejects.toThrow('no such webhook')
  })

  it('update, rotate, disable and delete name only the webhook; only rotate gives the new address', async () => {
    const h = harness()
    const renamed = await h.call('update', { webhook_id: HOOK, name: '发布告警' })
    expect(renamed).not.toHaveProperty('address')
    await h.call('update', { webhook_id: HOOK, targets: [] })
    expect((await h.call('rotate', { webhook_id: HOOK })).address).toBe(ADDRESS)
    expect(await h.call('disable', { webhook_id: HOOK, disabled: true })).not.toHaveProperty('address')
    expect(await h.call('delete', { webhook_id: HOOK })).not.toHaveProperty('address')
    const as = { p_as_user_id: 'agent-1' }
    expect(h.calls).toEqual([
      ['group_webhook_update', { p_webhook_id: HOOK, p_name: '发布告警', p_target_user_ids: null, ...as }],
      ['group_webhook_update', { p_webhook_id: HOOK, p_name: null, p_target_user_ids: [], ...as }],
      ['group_webhook_rotate', { p_webhook_id: HOOK, ...as }],
      ['group_webhook_set_disabled', { p_webhook_id: HOOK, p_disabled: true, ...as }],
      ['group_webhook_delete', { p_webhook_id: HOOK, ...as }],
    ])
  })
})
