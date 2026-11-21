import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error — injectable ESM message tool host.
import { callTool } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

const chat = '11111111-1111-4111-8111-111111111111'
const originChat = '22222222-2222-4222-8222-222222222222'
const origin = '33333333-3333-4333-8333-333333333333'
const agent = '44444444-4444-4444-8444-444444444444'
const link = `gugu-chat://${originChat}/${origin}`
const context = { agentId: agent, threadRootId: null, guguHome: '/tmp/reference-fixture' }

function fixture(readable: boolean, widget = false) {
  const restGet = vi.fn(async () => [])
  const restRpc = vi.fn(async (name: string) => {
    if (name === 'chat_facts') return [{ id: chat, kind: 'group', group_prompt: null }]
    if (name === 'list_member_ids') return [{ user_id: agent }]
    // The server reads as the agent: what it may not read has no row.
    if (name === 'messages_by_id_as') return readable ? [{ id: origin, chat_id: originChat, content_type: widget ? 'widget' : 'text',
      content: widget ? JSON.stringify({ v: 2, text: 'Counter', app: 'counter', view: 'main' }) : 'Private body', retracted_at: null, deleted_for_me: false }] : []
    if (name === 'widget_origin') return widget ? [{ widget_id: 'counter', origin_message_id: origin, is_retracted: false }] : []
    throw new Error(`Unexpected RPC ${name}`)
  })
  return { restGet, restRpc, restInsert: vi.fn() }
}
const send = (text: string, deps: ReturnType<typeof fixture>) => callTool(context, 'message_send', { chat_id: chat, text }, deps)

describe('message references at the actual send boundary', () => {
  it('refuses an unreadable block before writing the outgoing message', async () => {
    const deps = fixture(false)
    await expect(send(link, deps)).rejects.toThrow(`message_send: cannot reference ${origin}: not readable by you`)
    expect(deps.restInsert).not.toHaveBeenCalled()
    expect(deps.restRpc).toHaveBeenCalledWith('messages_by_id_as', { p_as: agent, p_id: origin, p_chat_id: originChat })
  })
  it('checks the agent rather than inheriting the owner read of a widget origin', async () => {
    const deps = fixture(false, true)
    await expect(send('gugu-widget://counter', deps)).rejects.toThrow('cannot reference counter: not readable by you')
    expect(deps.restInsert).not.toHaveBeenCalled()
  })
  it('sends a readable widget link using its checked origin without copying the widget input', async () => {
    const deps = fixture(true, true)
    await expect(send('gugu-widget://counter', deps)).resolves.toContain('sent')
    expect(deps.restRpc).toHaveBeenCalledWith('widget_origin', { p_widget_id: 'counter', p_as: agent })
    expect(deps.restInsert).toHaveBeenCalledWith('messages', expect.objectContaining({ content: 'gugu-widget://counter' }))
    expect(JSON.stringify(deps.restInsert.mock.calls)).not.toContain('Counter')
  })
  it('preserves a readable block as a link and never copies its private body into the send', async () => {
    const deps = fixture(true)
    await expect(send(link, deps)).resolves.toContain('sent')
    expect(deps.restInsert).toHaveBeenCalledWith('messages', expect.objectContaining({ content: link }))
    expect(JSON.stringify(deps.restInsert.mock.calls)).not.toContain('Private body')
  })
  it('uses the same top-level four-block limit, leaving quotes and fifth links as ordinary Markdown', async () => {
    const deps = fixture(true)
    const fifth = '55555555-5555-4555-8555-555555555555'
    await send(`${Array.from({ length: 4 }, () => link).join('\n\n')}\n\ngugu-chat://${originChat}/${fifth}\n\n> gugu-widget://hidden`, deps)
    expect(deps.restRpc.mock.calls.filter(([name]) => name === 'messages_by_id_as')).toHaveLength(4)
    expect(JSON.stringify(deps.restRpc.mock.calls)).not.toContain(fifth)
    expect(deps.restInsert).toHaveBeenCalledTimes(1)
  })
})
