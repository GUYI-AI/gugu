// @vitest-environment jsdom
import { notifyManager } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GroupCollabSnapshot } from '@gugu/core/shared/types/chat'

/**
 * A room's roster is one replica (hooks/useRoomCollab.ts): unknown until read (❌ an empty roster that draws "0
 * members"), the IM library's copy first for a group (not for a topic, whose participation must be confirmed), identities
 * written before the roster shows, an empty topic roster is a conclusion and a failed read is loud and keeps what is shown.
 */
const readGroupRoster = vi.fn()
const replaceGroupRoster = vi.fn()
const getGroupCollab = vi.fn()
const repository = { accountId: 'owner-1' }
vi.mock('../../../../apps/desktop/src/lib/imRepository', () => ({
  readGroupRoster,
  replaceGroupRoster,
  openedImRepository: async () => repository,
  persistableGroupRoster: (_chatId: string, value: GroupCollabSnapshot) => value,
}))
class GroupCollabEmptyError extends Error {}
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: { getGroupCollab }, GroupCollabEmptyError }))

const { groupRoster } = await import('../../../../apps/desktop/src/hooks/useRoomCollab')
const { followRendererSession, queryClient } = await import('../../../../apps/desktop/src/lib/replica')

const snapshot: GroupCollabSnapshot = {
  scheduler: { chat_id: 'group-1', paused: false, queue_count: 0, blocked_count: 0, summary: null, updated_at: new Date(0).toISOString() },
  humans: [{ id: 'owner-1', role: 'owner', type: 'human', account_status: null }],
  agents: [{ id: 'agent-1', role: 'member', type: 'agent', account_status: null, client: null, model_source: null, tools: [], permission_scope: null, current_task_id: null, current_task_title: null, last_action: null, last_active_at: null, listen_mode: 'active' }],
  tasks: [],
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

let errors: unknown[][]
beforeEach(() => {
  notifyManager.setScheduler((callback) => { callback() })
  followRendererSession('SIGNED_IN', 'owner-1')
  readGroupRoster.mockReset().mockReturnValue(null)
  replaceGroupRoster.mockReset().mockResolvedValue(undefined)
  getGroupCollab.mockReset().mockResolvedValue({ snapshot, identities: [] })
  errors = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args) })
})
afterEach(() => {
  queryClient.clear()
  vi.restoreAllMocks()
})

describe('groupRoster', () => {
  it('is unknown before it is read, never an empty roster', () => {
    expect(groupRoster.peek('group-1', 'group')).toEqual({ state: 'unknown' })
  })

  it('shows the local copy of a group first, then the read', async () => {
    readGroupRoster.mockReturnValue({ ...snapshot, agents: [] })
    let answer!: (value: unknown) => void
    getGroupCollab.mockReturnValue(new Promise((resolve) => { answer = resolve }))
    const pending = groupRoster.prefetch('group-1', 'group')
    await settle()
    expect(groupRoster.peek('group-1', 'group')).toMatchObject({ state: 'value', stale: true, value: { agents: [] } })
    answer({ snapshot, identities: [] }); await pending
    expect(groupRoster.peek('group-1', 'group')).toMatchObject({ state: 'value', value: { agents: [{ id: 'agent-1' }] } })
  })

  it('does not show a topic from the local copy: whether this viewer takes part is read first', async () => {
    readGroupRoster.mockReturnValue(snapshot)
    let answer!: (value: unknown) => void
    getGroupCollab.mockReturnValue(new Promise((resolve) => { answer = resolve }))
    const pending = groupRoster.prefetch('topic-1', 'topic')
    await settle()
    expect(groupRoster.peek('topic-1', 'topic')).toEqual({ state: 'unknown' })
    answer({ snapshot, identities: [] }); await pending
  })

  it('writes identities and roster locally before the roster shows', async () => {
    let written!: () => void
    replaceGroupRoster.mockReturnValue(new Promise<void>((resolve) => { written = resolve }))
    const pending = groupRoster.prefetch('group-1', 'group')
    await settle()
    expect(replaceGroupRoster).toHaveBeenCalledWith(repository, 'group-1', snapshot, [])
    expect(groupRoster.peek('group-1', 'group').state).toBe('unknown')
    written(); await pending
    expect(groupRoster.peek('group-1', 'group').state).toBe('value')
  })

  // @@@5856:「看得见这条话题但还不是参与者」是稳态,不是 RLS 抖动:不重试、不报错。
  it('an empty topic roster is a conclusion: one read, no error logged', async () => {
    getGroupCollab.mockRejectedValue(new GroupCollabEmptyError('empty'))
    await groupRoster.prefetch('topic-1', 'topic')
    expect(groupRoster.peek('topic-1', 'topic')).toMatchObject({ state: 'error' })
    expect(getGroupCollab).toHaveBeenCalledTimes(1)
    expect(errors).toEqual([])
  })

  it('an empty group roster can only be a fault: reported', async () => {
    getGroupCollab.mockRejectedValue(new GroupCollabEmptyError('empty'))
    await groupRoster.prefetch('group-1', 'group')
    expect(errors.length).toBeGreaterThan(0)
  })

  it('a failed read keeps the shown roster and says so, without retrying', async () => {
    await groupRoster.prefetch('group-1', 'group')
    getGroupCollab.mockRejectedValue(new Error('boom'))
    await groupRoster.refresh('group-1')
    await groupRoster.prefetch('group-1', 'group') // where it is shown, the refresh reads again
    expect(groupRoster.peek('group-1', 'group')).toMatchObject({ state: 'value', value: { humans: [{ id: 'owner-1' }] }, error: { message: 'boom' } })
    expect(getGroupCollab).toHaveBeenCalledTimes(2)
    expect(errors.length).toBeGreaterThan(0)
  })

  it('a malformed local copy fails the read loudly and is not read around from the cloud', async () => {
    readGroupRoster.mockImplementation(() => { throw new Error('malformed membership row') })
    await groupRoster.prefetch('group-1', 'group')
    expect(groupRoster.peek('group-1', 'group')).toMatchObject({ state: 'error', error: { message: 'malformed membership row' } })
    expect(getGroupCollab).not.toHaveBeenCalled()
    expect(errors.length).toBeGreaterThan(0)
  })

  it('a refresh keeps the rows already drawn in their order (survivors first)', async () => {
    const two = { ...snapshot, humans: [snapshot.humans[0]!, { id: 'b', role: 'member' as const, type: 'human' as const, account_status: null }] }
    getGroupCollab.mockResolvedValueOnce({ snapshot: two, identities: [] })
    await groupRoster.prefetch('group-1', 'group')
    getGroupCollab.mockResolvedValueOnce({ snapshot: { ...two, humans: [...two.humans].reverse() }, identities: [] })
    await groupRoster.refresh('group-1')
    await groupRoster.prefetch('group-1', 'group')
    const reading = groupRoster.peek('group-1', 'group')
    expect(reading.state === 'value' && reading.value.humans.map((member) => member.id)).toEqual(['owner-1', 'b'])
  })
})
