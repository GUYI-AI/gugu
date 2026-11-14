import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerGuguWidgetTool } from '../../../../apps/desktop/electron/mcp/gugu-widget-tool'
import type { AppSearchHit, AppSearchSource } from '../../../../apps/desktop/electron/mcp/gugu-app-search-tool'
import { parseExtensionManifest } from '../../../../apps/desktop/src/session/shared/extensions/manifest'
// @ts-expect-error -- injectable ESM message writer
import { sendWidgetOf, widgetGetOf } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

const manifest = parseExtensionManifest({ id: 'board', name: 'Board', version: '1.0.0', apiVersion: 26, defaultLocale: 'en', entry: 'main.html', contributes: { tabs: [{ name: 'main', title: 'Board', widget: { height: 240 } }] } })
const hit: AppSearchHit = { manifest, version: '1.0.0', state: 'on', widgetViews: [{ view: 'main', height: 240 }] }
const args = { chat_id: 'chat', app: 'board', view: 'main', text: 'Results', data: { count: 2 } }
const clients: Client[] = []
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())) })

async function connect(source: AppSearchSource) {
  const send = vi.fn().mockResolvedValue('sent (id=message)')
  const get = vi.fn().mockResolvedValue('{"widget_id":"stable-widget"}')
  const server = new McpServer({ name: 'widget', version: '1' })
  registerGuguWidgetTool(server, source, send, get)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'widget-test', version: '1' })
  clients.push(client)
  await Promise.all([server.connect(b), client.connect(a)])
  return { send, get, call: async (input: Record<string, unknown>, name = 'widget_send') => {
    const result = await client.callTool({ name, arguments: input })
    return { error: result.isError, text: (result.content as { text: string }[])[0]!.text }
  } }
}

describe('widget_send', () => {
  it('serializes v2 and preserves the explicitly named destination', async () => {
    const { call, send } = await connect(async () => ({ apps: [hit] }))
    expect((await call(args)).error).not.toBe(true)
    expect(send).toHaveBeenCalledWith(args, JSON.stringify({ v: 2, text: 'Results', app: 'board', view: 'main', data: { count: 2 } }))
  })
  it.each([64, 140, 480, 520])('writes the optional height %s into the message', async height => {
    const { call, send } = await connect(async () => ({ apps: [hit] }))
    expect((await call({ ...args, height })).error).not.toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
    expect(JSON.parse(send.mock.calls[0]![1])).toEqual({ v: 2, text: 'Results', app: 'board', view: 'main', height, data: { count: 2 } })
  })
  it.each([20, 900, 300.5, 63, 521, null, '140'])('rejects invalid height %s before posting', async height => {
    const { call, send } = await connect(async () => ({ apps: [hit] }))
    expect(await call({ ...args, height })).toMatchObject({ error: true, text: expect.stringMatching(/height.*64.*520/s) })
    expect(send).not.toHaveBeenCalled()
  })
  it('refuses oversized UTF-8 input before any write and says the actual size', async () => {
    const { call, send } = await connect(async () => ({ apps: [hit] }))
    expect(await call({ ...args, data: { s: '界'.repeat(1363) } })).toMatchObject({ error: true, text: expect.stringContaining('4097 UTF-8 bytes') })
    expect((await call({ ...args, text: '' })).text).toContain('1–200')
    expect(send).not.toHaveBeenCalled()
  })
  it('returns the database rejection as a visible tool error without reporting a send', async () => {
    const { call, send } = await connect(async () => ({ apps: [hit] }))
    const message = '23514: new row violates check constraint messages_widget_shape'
    send.mockRejectedValueOnce(new Error(message))
    expect(await call({ ...args, data: { text: '\u0000' } })).toEqual({ error: true, text: message })
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('reads current App scope at each call, refusing off Apps and undeclared views', async () => {
    let state = 'off' as AppSearchHit['state']
    const { call, send } = await connect(async () => ({ apps: [{ ...hit, state }] }))
    expect((await call(args)).error).toBe(true)
    state = 'on'
    expect((await call({ ...args, view: 'other' })).error).toBe(true)
    expect(send).not.toHaveBeenCalled()
    expect((await call(args)).error).not.toBe(true)
  })
  it('refuses an unavailable App source rather than returning an empty result', async () => {
    const { call, send } = await connect(() => null)
    expect((await call(args)).text).toContain('not a side chat')
    expect(send).not.toHaveBeenCalled()
  })
  it('uses the idempotent widget RPC and preserves the fixed sender, thread and height', async () => {
    const rows: Record<string, unknown>[] = []
    const chat = '127ec4f0-30b1-4583-b469-706756153bdd'
    const context = { agentId: 'agent', threadRootId: 'thread', guguHome: '/tmp/widget-test' }
    const deps = {
      restGet: async () => [],
      restRpc: async (name: string, body: Record<string, unknown>) => {
        if (name === 'chat_facts') return [{ id: chat, kind: 'group', group_prompt: null }]
        if (name === 'list_member_ids') return [{ user_id: 'agent' }]
        expect(name).toBe('send_widget')
        rows.push(body)
        return [{ message_id: body.p_message_id, widget_id: 'stable-widget', seq: 1 }]
      },
      restInsert: vi.fn(),
    }
    const content = JSON.stringify({ v: 2, text: args.text, app: args.app, view: args.view, data: args.data, height: 360 })
    const receipt = JSON.parse(await sendWidgetOf(context, { ...args, chat_id: chat }, content, deps))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ p_sender_user_id: 'agent', p_chat_id: chat, p_text: args.text, p_app: args.app, p_view: args.view, p_data: args.data, p_thread_root_id: 'thread', p_height: 360 })
    expect(rows[0]!.p_message_id).toEqual(expect.any(String))
    expect(rows[0]).not.toHaveProperty('p_widget_id')
    expect(deps.restInsert).not.toHaveBeenCalled()
    // The task timeline draws the widget from its arguments and this receipt: the chat it landed in and its identity.
    expect(receipt).toEqual({ status: 'sent', message_id: rows[0]!.p_message_id, widget_id: 'stable-widget', source_link: `gugu-chat://${chat}/${rows[0]!.p_message_id}` })
    await expect(sendWidgetOf({ ...context, forkOf: 'origin' }, args, content, deps)).rejects.toThrow('side chat')
  })
})

describe('widget_get', () => {
  const origin = { widget_id: 'stable-widget', origin_message_id: 'origin', is_retracted: false }
  const message = { id: 'origin', chat_id: 'chat', content_type: 'widget', sender_user_id: 'author', retracted_at: null, deleted_for_user_ids: [],
    content: JSON.stringify({ v: 2, wid: 'stable-widget', text: 'Lunch', app: 'vote', view: 'poll', height: 160, data: { question: 'Noodles?' } }) }
  const deps = (found: { origin?: typeof origin | null; readable?: boolean } = {}) => ({
    restGet: vi.fn(async () => [message]),
    restRpc: vi.fn(async (name: string, body: Record<string, unknown>) => {
      if (name === 'widget_origin') return found.origin === null ? [] : [found.origin ?? origin]
      if (name === 'can_read_message') { expect(body).toEqual({ p_message_id: 'origin', p_user_id: 'agent' }); return found.readable ?? true }
      throw new Error(`unexpected ${name}`)
    }),
  })
  const context = { agentId: 'agent', guguHome: '/tmp/widget-test' }

  it('is a tool beside widget_send that passes the id through', async () => {
    const { call, get } = await connect(async () => ({ apps: [hit] }))
    const read = await call({ widget_id: 'stable-widget' }, 'widget_get')
    expect(read.error).not.toBe(true)
    expect(read.text).toBe('{"widget_id":"stable-widget"}')
    expect(get).toHaveBeenCalledWith('stable-widget')
    expect((await call({}, 'widget_get')).error).toBe(true)
  })
  it('reads the spec through the registry, as the agent', async () => {
    expect(JSON.parse(await widgetGetOf(context, 'stable-widget', deps()))).toEqual({ widget_id: 'stable-widget', chat_id: 'chat', message_id: 'origin',
      app: 'vote', view: 'poll', text: 'Lunch', height: 160, data: { question: 'Noodles?' }, sender: 'author' })
  })
  it.each([
    ['the agent cannot read the original', { readable: false }],
    ['the widget is not registered', { origin: null }],
    ['the widget is retracted', { origin: { ...origin, is_retracted: true } }],
  ])('says not found when %s', async (_case, found) => {
    await expect(widgetGetOf(context, 'stable-widget', deps(found))).rejects.toThrow('widget_get: there is no widget stable-widget you can read')
  })
  it('refuses an empty id without reading', async () => {
    const d = deps()
    await expect(widgetGetOf(context, '', d)).rejects.toThrow('no widget')
    expect(d.restRpc).not.toHaveBeenCalled()
  })
})
