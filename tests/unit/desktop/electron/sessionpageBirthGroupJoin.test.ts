import { beforeEach, describe, expect, it, vi } from 'vitest'

// The born-in-chat join: transient rollbacks are retried, a join that still fails is kept on the roster row and announced,
// and the session page's retry settles it.
type Row = { gugu_user_id: string; owner_user_id: string; cache: Record<string, unknown> }
const roster: Row[] = []
const answers: Array<{ data: unknown; error: { message: string; code?: string } | null }> = []
const calls: Array<Record<string, unknown>> = []

vi.mock('@gugu/core', () => ({
  listAgents: async () => roster,
  updateAgent: async (where: { guguUserId: string }, patch: { cache: Record<string, unknown> }) => {
    const row = roster.find((r) => r.gugu_user_id === where.guguUserId)
    if (!row) throw new Error('no roster row')
    row.cache = patch.cache
  },
}))
vi.mock('@main/core/sessionpage/sessionpage-session-agent', () => ({
  localAgentForSession: async (sessionId: string) => roster.find((r) => r.cache.sessionpage_session_id === sessionId) ?? null,
}))
vi.mock('../../../../apps/desktop/electron/supabase', () => ({
  makeChatClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, ...args })
      return answers.shift() ?? { data: { status: 'joined', chat_id: args.p_chat_id }, error: null }
    },
  }),
}))

const {
  BIRTH_GROUP_JOIN_CACHE_KEY, joinBirthGroup, onSessionpageBirthGroupJoin, retrySessionpageBirthGroupJoin,
  sessionpageBirthGroupJoin, setBirthGroupJoinRetryDelaysForTests,
} = await import('../../../../apps/desktop/electron/sessionpage/sessionpage-birth-group-join')

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
const env = {} as NodeJS.ProcessEnv
const deadlock = { data: null, error: { message: 'deadlock detected', code: '40P01' } }
const join = (sessionId = 's1') => joinBirthGroup({
  env, accessToken: 'token', ownerUserId: 'owner', sessionId, agentUserId: 'agent-1', group: { chatId: 'chat-1', asTask: false }, log,
})

beforeEach(() => {
  roster.length = 0
  answers.length = 0
  calls.length = 0
  roster.push({ gugu_user_id: 'agent-1', owner_user_id: 'owner', cache: { sessionpage_session_id: 's1' } })
  setBirthGroupJoinRetryDelaysForTests([0, 0])
})

describe('born-in-chat join', () => {
  it('retries a deadlock victim and records nothing once the group answers', async () => {
    answers.push(deadlock, deadlock)
    await join()
    expect(calls).toHaveLength(3)
    expect(roster[0]!.cache[BIRTH_GROUP_JOIN_CACHE_KEY]).toBeUndefined()
  })

  it('keeps a refusal without retrying it, and announces it', async () => {
    const seen: unknown[] = []
    const off = onSessionpageBirthGroupJoin((event) => seen.push(event))
    answers.push({ data: null, error: { message: 'member_limit_reached', code: '23514' } })
    await join()
    off()
    expect(calls).toHaveLength(1)
    expect(roster[0]!.cache[BIRTH_GROUP_JOIN_CACHE_KEY]).toEqual({ chatId: 'chat-1', asTask: false, reason: 'member_limit_reached' })
    expect(seen).toEqual([{ sessionId: 's1', join: { chatId: 'chat-1', reason: 'member_limit_reached' } }])
    expect(await sessionpageBirthGroupJoin('s1', env, 'owner')).toEqual({ chatId: 'chat-1', reason: 'member_limit_reached' })
  })

  it('records the last deadlock once the retries run out', async () => {
    answers.push(deadlock, deadlock, deadlock)
    await join()
    expect(calls).toHaveLength(3)
    expect(roster[0]!.cache[BIRTH_GROUP_JOIN_CACHE_KEY]).toEqual({ chatId: 'chat-1', asTask: false, reason: 'deadlock detected' })
  })

  it('a retry from the session page joins and clears what was pending', async () => {
    roster[0]!.cache[BIRTH_GROUP_JOIN_CACHE_KEY] = { chatId: 'chat-1', asTask: true, reason: 'deadlock detected' }
    const seen: unknown[] = []
    const off = onSessionpageBirthGroupJoin((event) => seen.push(event))
    expect(await retrySessionpageBirthGroupJoin('s1', env, { accessToken: 'token', userId: 'owner' }, log)).toBeNull()
    off()
    expect(calls).toEqual([expect.objectContaining({ name: 'add_group_agent', p_chat_id: 'chat-1', p_agent_user_id: 'agent-1', p_as_task: true })])
    expect(roster[0]!.cache[BIRTH_GROUP_JOIN_CACHE_KEY]).toBeUndefined()
    expect(seen).toEqual([{ sessionId: 's1', join: null }])
    expect(await sessionpageBirthGroupJoin('s1', env, 'owner')).toBeNull()
  })
})
