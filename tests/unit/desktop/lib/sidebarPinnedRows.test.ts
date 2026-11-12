// GUYI-AI/gugu#2548 固定到左侧栏 in the one list: a pinned agent keeps its own row although it lives elsewhere, and the
// pinned agents' rows sit at the very top in the order the task page publishes them (newest interaction first).
import { describe, expect, it } from 'vitest'
import { agentHasOwnRow, oneListShows, sidebarPinnedRows, type AgentHomes } from '../../../../apps/desktop/src/lib/sidebarOneList'
import { chat } from '../../../support/testHarness'

const homes = (parts: Partial<Record<keyof AgentHomes, string[]>> = {}): AgentHomes => ({
  inRooms: new Set(parts.inRooms), inProjects: new Set(parts.inProjects), withTopLevelTask: new Set(parts.withTopLevelTask), pinned: new Set(parts.pinned), onlyForks: new Set(parts.onlyForks),
})
const owns = (id: string) => id.startsWith('a-')

describe('the pin exception: a pinned agent has its own row wherever it lives', () => {
  it.each([
    [homes({ inRooms: ['a'], pinned: ['a'] }), true],
    [homes({ inProjects: ['a'], pinned: ['a'] }), true],
    [homes({ inRooms: ['a'], pinned: ['b'] }), false],
    [homes({ pinned: ['a'] }), true],
  ])('%#', (agentHomes, expected) => expect(agentHasOwnRow('a', agentHomes)).toBe(expected))

  it('the one list shows a pinned agent\'s DM even before it has a message (its pinned session is the conversation)', () => {
    const agentHomes = homes({ inRooms: ['a-room'], inProjects: ['a-project'], pinned: ['a-room'] })
    expect(oneListShows(chat({ kind: 'dm', peer_user_id: 'a-room' }), false, agentHomes, owns)).toBe(true)
    expect(oneListShows(chat({ kind: 'dm', peer_user_id: 'a-project' }), true, agentHomes, owns)).toBe(false)
  })
})

describe('the pinned rows at the top of the one list', () => {
  const chats = [
    chat({ id: 'room', kind: 'group', member_user_ids: ['a-room'] }),
    chat({ id: 'dm-room', kind: 'dm', peer_user_id: 'a-room' }),
    chat({ id: 'dm-project', kind: 'ai', peer_user_id: 'a-project' }),
    chat({ id: 'dm-hidden', kind: 'dm', peer_user_id: 'a-hidden' }),
  ]
  const pin = (agentUserId: string) => ({ agentUserId, sessionId: `s-${agentUserId}`, home: { kind: 'group' as const, name: 'Room' } })

  it('are each pinned agent\'s DM row, in the order of the pins, with the pin it stands for', () => {
    const rows = sidebarPinnedRows(chats, [pin('a-project'), pin('a-room')], () => true)
    expect(rows.map(({ chat, pin }) => [chat.id, pin.sessionId])).toEqual([['dm-project', 's-a-project'], ['dm-room', 's-a-room']])
  })

  it('leave out an agent with no DM chat (nothing drawn in its place), a DM the list does not show, and a group the agent is in', () => {
    const rows = sidebarPinnedRows(chats, [pin('a-nodm'), pin('a-hidden'), pin('a-room')], (candidate) => candidate.id !== 'dm-hidden')
    expect(rows.map(({ chat }) => chat.id)).toEqual(['dm-room'])
  })

  it('draw an agent pinned through two sessions once, at its first pin', () => {
    const rows = sidebarPinnedRows(chats, [pin('a-room'), pin('a-project'), { ...pin('a-room'), sessionId: 's-other' }], () => true)
    expect(rows.map(({ chat, pin }) => [chat.id, pin.sessionId])).toEqual([['dm-room', 's-a-room'], ['dm-project', 's-a-project']])
  })
})
