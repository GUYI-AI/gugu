// Owner 2026-11-16: a message id handed to an IM tool may be its first 8+ characters. It is matched among the messages the
// agent can read (in chat_id when the tool names one); the handler, and whatever it stores or sends, sees the full id.
import { describe, expect, it } from 'vitest'
// @ts-expect-error — the injected MCP server is an untyped .mjs; it imports fine at runtime.
import { callTool } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

const AGENT = '11111111-1111-4111-8111-111111111111'
const CHAT = '33333333-3333-4333-8333-333333333333'
const FULL = 'abcdef12-3456-4789-8abc-def012345678'
const OTHER = 'abcdef12-0000-4000-8000-000000000000'
const context = { agentId: AGENT, supabaseUrl: '', anonKey: '', getAccessToken: async () => 'token', threadRootId: null }

function deps(rows: Array<{ id: string; content: string; created_at: string }>, hidden: string[] = []) {
  const gets: string[] = []
  const rpcs: Array<[string, Record<string, unknown>]> = []
  return {
    gets, rpcs,
    restGet: async (path: string) => {
      gets.push(path)
      return []
    },
    restRpc: async (name: string, body: Record<string, unknown>) => {
      rpcs.push([name, body])
      // The server's answer as the agent: a message it may not read is not there.
      if (name === 'messages_by_id_as') {
        // A short id spans the UUIDs it starts; anything else is matched as written.
        const id = String(body.p_id)
        return rows.filter((row) => (id.length < 36 ? row.id.startsWith(id) : row.id === id) && !hidden.includes(row.id))
      }
      if (name === 'chat_facts') return [{ id: body.p_chat_id, kind: 'group', source_chat_id: null, group_prompt: null }]
      return []
    },
  }
}

const history = (thread: string, d: ReturnType<typeof deps>) => callTool(context, 'message_history', { chat_id: CHAT, thread_root_id: thread }, d)

describe('message ids written as a prefix', () => {
  it('reads the thread of the one message the prefix names in that chat', async () => {
    const d = deps([{ id: FULL, content: 'root', created_at: '2026-11-16T10:00:00Z' }])
    await history('msg:abcdef12', d)
    expect(d.rpcs[0]).toEqual(['messages_by_id_as', { p_as: AGENT, p_id: 'abcdef12', p_chat_id: CHAT }])
    const read = d.rpcs.find(([name]) => name === 'message_history_as')
    expect(read?.[1].p_thread_root_id).toBe(FULL)
  })

  it('refuses several with the candidates, and says so first when none matches — a message it cannot read counts as none', async () => {
    const two = deps([{ id: FULL, content: 'one', created_at: 't1' }, { id: OTHER, content: 'two', created_at: 't2' }])
    await expect(history('msg:abcdef12', two)).rejects.toThrow(`msg:abcdef12 matches 2 messages: msg:${FULL} ("one", t1), msg:${OTHER} ("two", t2). Pass a longer prefix or the full id`)
    const hidden = deps([{ id: FULL, content: 'secret', created_at: 't1' }], [FULL])
    await expect(history('msg:abcdef12', hidden)).rejects.toThrow(`No message matches msg:abcdef12 in chat ${CHAT}; message_history lists message ids`)
    expect([...two.rpcs, ...hidden.rpcs].map(([name]) => name)).not.toContain('message_history_as')
  })

  it('a full id is never looked up', async () => {
    const d = deps([])
    await history(`msg:${FULL}`, d)
    expect(d.rpcs.map(([name]) => name)).not.toContain('messages_by_id_as')
    expect(d.rpcs.find(([name]) => name === 'message_history_as')?.[1].p_thread_root_id).toBe(FULL)
  })

  it('a file is fetched by its message prefix among every message the agent can read', async () => {
    const d = deps([{ id: FULL, content: 'file', created_at: 't1' }])
    await callTool(context, 'message_download_file', { source_message_id: 'msg:abcdef12' }, d).catch(() => null)
    expect(d.rpcs[0]).toEqual(['messages_by_id_as', { p_as: AGENT, p_id: 'abcdef12', p_chat_id: null }])
    // The full id goes on to the download, which reads it as the agent too; nothing reads with the owner's token.
    expect(d.rpcs.filter(([name]) => name === 'messages_by_id_as').at(-1)?.[1]).toMatchObject({ p_as: AGENT, p_id: FULL })
    expect(d.gets).toEqual([])
  })
})
