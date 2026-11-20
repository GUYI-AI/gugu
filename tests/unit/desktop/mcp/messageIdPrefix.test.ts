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
      if (path.startsWith('messages?id=gte.')) return rows
      return []
    },
    restRpc: async (name: string, body: Record<string, unknown>) => {
      rpcs.push([name, body])
      if (name === 'can_read_message') return !hidden.includes(String(body.p_message_id))
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
    expect(d.gets[0]).toBe(`messages?id=gte.abcdef12-0000-0000-0000-000000000000&id=lte.abcdef12-ffff-ffff-ffff-ffffffffffff&chat_id=eq.${CHAT}`
      + '&select=id,content,created_at&order=created_at.desc&limit=11')
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
    expect(d.gets.filter((path) => path.startsWith('messages?id=gte.'))).toEqual([])
    expect(d.rpcs.find(([name]) => name === 'message_history_as')?.[1].p_thread_root_id).toBe(FULL)
  })

  it('a file is fetched by its message prefix among every message the agent can read', async () => {
    const d = deps([{ id: FULL, content: 'file', created_at: 't1' }])
    await callTool(context, 'message_download_file', { source_message_id: 'msg:abcdef12' }, d).catch(() => null)
    expect(d.gets[0]).toBe('messages?id=gte.abcdef12-0000-0000-0000-000000000000&id=lte.abcdef12-ffff-ffff-ffff-ffffffffffff&select=id,content,created_at&order=created_at.desc&limit=11')
    expect(d.gets[1]).toContain(`messages?id=eq.${FULL}`)
  })
})
