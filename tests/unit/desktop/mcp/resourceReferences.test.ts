import { describe, expect, it, vi } from 'vitest'
import { guguLink, parseGuguLink } from '@gugu/core/shared/ui/guguLink'
// @ts-expect-error The injectable MCP dispatcher is JavaScript.
import { callTool } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

const chat = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const message = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const agent = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const context = { agentId: agent, getAccessToken: async () => '', threadRootId: null }

function rig(readable: boolean, page: object[] = []) {
  const restRpc = vi.fn(async (name: string) => {
    if (name === 'chat_facts') return readable ? [{ id: chat, kind: 'group' }] : []
    if (name === 'message_history_as' || name === 'message_search_as') return page
    throw new Error(`Unexpected RPC: ${name}`)
  })
  return { restRpc, restGet: vi.fn(async () => []) }
}

describe('message_history / message_search on a chat the reader cannot see', () => {
  it.each(['message_history', 'message_search'])('%s fails loudly instead of returning an empty page', async name => {
    await expect(callTool(context, name, { chat_id: chat, query: 'x' }, rig(false))).rejects.toThrow('Conversation is unavailable for this reader')
    expect(JSON.parse(await callTool(context, name, { chat_id: chat, query: 'x' }, rig(true)))).toEqual([])
  })

  it('keeps the original msg: row ids', async () => {
    const rows = JSON.parse(await callTool(context, 'message_history', { chat_id: chat }, rig(true, [{ id: message, seq: 1, content: 'hi' }])))
    expect(rows[0]).toMatchObject({ id: `msg:${message}` })
  })
})

describe('session item reference identity', () => {
  it('round-trips opaque case-sensitive session/item identities through the shared parser', () => {
    const target = { kind: 'session' as const, sessionId: 'Session-A', itemId: 'turn:2/item(1)?%=中' }
    expect(parseGuguLink(guguLink(target))).toEqual(target)
    for (const uri of ['gugu-session://s?message=%ZZ', 'gugu-session://s?message=x&extra=y']) expect(parseGuguLink(uri)).toBeNull()
  })
})
