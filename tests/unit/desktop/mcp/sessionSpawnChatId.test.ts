import { beforeEach, describe, expect, it, vi } from 'vitest'

// session_spawn's chat_id is read the way message tools read it (resolveChatIdInput): a public_id reaches the birth-chat
// join as the chat's UUID, and one that names no chat fails at the tool. Before, the raw "229808" went to add_group_agent,
// which answered not_a_group, and the child ran outside its group.
const calls: Array<Record<string, unknown>> = []
vi.mock('@gugu/core', () => ({ listAgents: async () => [], updateAgent: async () => {} }))
vi.mock('@main/core/sessionpage/sessionpage-session-agent', () => ({ localAgentForSession: async () => null }))
vi.mock('../../../../apps/desktop/electron/supabase', () => ({
  makeChatClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, ...args })
      return { data: { status: 'joined', chat_id: args.p_chat_id }, error: null }
    },
  }),
}))

const { SESSION_TOOL_DEFS } = await import('../../../../apps/desktop/electron/mcp/gugu-session-tool')
const { registerSessionpageTools, withResolvedChatId } = await import('../../../../apps/desktop/electron/mcp/sessionpage-tool-registrar')
// @ts-expect-error — the injected MCP server is untyped .mjs; the runtime import works.
const { resolveChatIdOf } = await import('../../../../apps/desktop/electron/mcp/gugu-im-server.mjs')
const { joinBirthGroup } = await import('../../../../apps/desktop/electron/sessionpage/sessionpage-birth-group-join')

const GROUP = '33333333-3333-4333-8333-333333333333'
const context = { agentId: '11111111-1111-4111-8111-111111111111', supabaseUrl: '', anonKey: '', getAccessToken: async () => 'token' }
const restGet = async (path: string) => {
  const publicId = /chats\?public_id=eq\.(\d+)/.exec(path)?.[1]
  return publicId === '229808' ? [{ id: GROUP, public_id: 229808 }] : []
}
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never

/** session_spawn as the host wires it: the chat_id boundary, then the birth-chat join the child is spawned with (session-orchestration). */
async function spawn(args: Record<string, unknown>) {
  const dispatched: Array<Record<string, unknown>> = []
  const dispatch = withResolvedChatId(async (action) => {
    const spawned = action as Record<string, unknown>
    dispatched.push(spawned)
    await joinBirthGroup({
      env: {} as NodeJS.ProcessEnv, accessToken: 'token', ownerUserId: 'owner', sessionId: 's1', agentUserId: 'agent-1',
      group: typeof spawned.chat_id === 'string' ? { chatId: spawned.chat_id, asTask: true } : null, log,
    })
    return { session_id: 'f531076b-76ad-4186-b6b0-e5f0d8963dba' }
  }, (chatId) => resolveChatIdOf(context, chatId, { restGet }))
  let run: ((args: unknown, extra: { signal: AbortSignal }) => Promise<unknown>) | undefined
  registerSessionpageTools({ registerTool: (_name: string, _options: unknown, handler: typeof run) => { run = handler } } as never,
    [SESSION_TOOL_DEFS.find((def) => def.name === 'session_spawn')!], dispatch, () => 'unavailable', (async (work: Promise<unknown>) => work) as never)
  return { result: run!(args, { signal: new AbortController().signal }), dispatched }
}

beforeEach(() => { calls.length = 0 })

describe('session_spawn chat_id', () => {
  it('a public_id joins the child to the chat by its UUID', async () => {
    const { result, dispatched } = await spawn({ prompt: 'go', chat_id: '229808' })
    await result
    expect(dispatched[0]?.chat_id).toBe(GROUP)
    expect(calls).toEqual([expect.objectContaining({ name: 'add_group_agent', p_chat_id: GROUP, p_agent_user_id: 'agent-1', p_as_task: true })])
  })

  // The live run: an agent told to pass the number "as a string" sent it with its quotes; that went to the join unchanged.
  it.each([['"229808"', 'a quoted public_id'], ['chat-229808', 'an opaque value']])('%s (%s) fails at the tool instead of reaching the join', async (chatId) => {
    const { result, dispatched } = await spawn({ prompt: 'go', chat_id: chatId })
    const answer = await result as { isError?: boolean; content: { text: string }[] }
    expect(answer.isError).toBe(true)
    expect(answer.content[0]!.text).toContain(`chat_id ${chatId} names no conversation`)
    expect(dispatched).toEqual([])
    expect(calls).toEqual([])
  })

  it('a public_id that names no chat fails at the tool: nothing is spawned or joined', async () => {
    const { result, dispatched } = await spawn({ prompt: 'go', chat_id: '999999' })
    const answer = await result as { isError?: boolean; content: { text: string }[] }
    expect(answer.isError).toBe(true)
    expect(answer.content[0]!.text).toContain('chat_id 999999 looks like a public_id, but no conversation matched it')
    expect(dispatched).toEqual([])
    expect(calls).toEqual([])
  })
})
