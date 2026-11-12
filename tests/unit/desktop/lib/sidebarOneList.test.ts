import { describe, expect, it } from 'vitest'
import type { SessionpageProjectSummary, SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import {
  agentHasOwnRow,
  agentsInRooms,
  agentTaskHomes,
  oneListShows,
  projectsWithoutGroupRow,
  type AgentHomes,
} from '../../../../apps/desktop/src/lib/sidebarOneList'
import { sidebarChatSignals } from '../../../../apps/desktop/src/lib/sidebarChatsBridge'
import { chat } from '../../../support/testHarness'

const project = (id: string, kind?: 'workspace'): SessionpageProjectSummary => ({ id, name: id, path: `/${id}`, ...(kind ? { kind } : {}) })
const session = (conversationId: string, projectId: string, agent: string | null, parent: string | null = null): SessionpageSessionSummary => ({
  conversationId, projectId, title: conversationId, harness: 'codex', runtime: 'acp', agentStatus: 'idle', lastInteractedAt: null,
  supported: true, parentConversationId: parent, agent: agent ? { userId: agent } : null,
})
const homes = (parts: Partial<Record<keyof AgentHomes, string[]>> = {}): AgentHomes => ({
  inRooms: new Set(parts.inRooms), inProjects: new Set(parts.inProjects), withTopLevelTask: new Set(parts.withTopLevelTask),
})
const mine = new Set(['a-solo', 'a-room', 'a-project', 'a-idle'])
const owns = (id: string) => mine.has(id)

describe('which agents live in a room', () => {
  it('counts the agent members of every group, project groups included, and nothing else', () => {
    const members: Record<string, string[]> = { room: ['a-room'], project: ['a-project'], topic: ['a-topic'], dm: ['a-dm'] }
    const chats = [chat({ id: 'room', kind: 'group' }), chat({ id: 'project', kind: 'group' }), chat({ id: 'topic', kind: 'topic' }), chat({ id: 'dm', kind: 'dm' })]
    expect([...agentsInRooms(chats, (id) => members[id]!)].sort()).toEqual(['a-project', 'a-room'])
  })
})

describe('which agents live in a project and which have a top-level task', () => {
  it('a session in a project puts its agent in the project; the task workspace is not a project', () => {
    const { inProjects, withTopLevelTask } = agentTaskHomes([{
      projects: [project('app'), project('tasks', 'workspace')],
      sessions: [session('s1', 'app', 'a-project'), session('s2', 'tasks', 'a-solo'), session('s3', 'tasks', null)],
    }])
    expect([...inProjects]).toEqual(['a-project'])
    expect([...withTopLevelTask]).toEqual(['a-solo'])
  })

  it('a fork hangs under its parent and is not a top-level task; an orphaned fork is', () => {
    const { withTopLevelTask } = agentTaskHomes([{
      projects: [project('tasks', 'workspace')],
      sessions: [session('root', 'tasks', 'a-root'), session('fork', 'tasks', 'a-fork', 'root'), session('orphan', 'tasks', 'a-orphan', 'archived')],
    }])
    expect([...withTopLevelTask].sort()).toEqual(['a-orphan', 'a-root'])
  })

  it('reads each machine against its own projects; a session whose project the machine did not report is a task', () => {
    const { inProjects, withTopLevelTask } = agentTaskHomes([
      { projects: [project('app')], sessions: [session('s1', 'app', 'a-1')] },
      { projects: [], sessions: [session('s2', 'app', 'a-2')] },
    ])
    expect([...inProjects]).toEqual(['a-1'])
    expect([...withTopLevelTask]).toEqual(['a-2'])
  })

  it('a fork on another machine still hangs under its parent', () => {
    const { withTopLevelTask } = agentTaskHomes([
      { projects: [project('tasks', 'workspace')], sessions: [session('root', 'tasks', 'a-root')] },
      { projects: [project('tasks2', 'workspace')], sessions: [session('fork', 'tasks2', 'a-fork', 'root')] },
    ])
    expect([...withTopLevelTask]).toEqual(['a-root'])
  })
})

describe('an owned agent has its own row only when it lives in no group and no project', () => {
  it.each([
    [homes(), true],
    [homes({ inRooms: ['a'] }), false],
    [homes({ inProjects: ['a'] }), false],
    [homes({ withTopLevelTask: ['a'] }), true],
  ])('%#', (agentHomes, expected) => expect(agentHasOwnRow('a', agentHomes)).toBe(expected))
})

describe('what the one list shows', () => {
  const agentHomes = homes({ inRooms: ['a-room'], inProjects: ['a-project'], withTopLevelTask: ['a-solo', 'a-room'] })
  const show = (overrides: Parameters<typeof chat>[0], listed: boolean) => oneListShows(chat(overrides), listed, agentHomes, owns)

  it('never shows a topic as a row, listed or not', () => {
    expect(show({ kind: 'topic', source_chat_id: 'room' }, true)).toBe(false)
  })

  it('shows groups and project groups by the list rule', () => {
    expect(show({ kind: 'group' }, true)).toBe(true)
  })

  it('shows direct messages with people (and with other people\'s agents) by the list rule', () => {
    expect(show({ kind: 'dm', peer_user_id: 'human' }, true)).toBe(true)
    expect(show({ kind: 'dm', peer_user_id: 'human' }, false)).toBe(false)
    expect(show({ kind: 'dm', peer_user_id: 'someone-elses-agent' }, true)).toBe(true)
  })

  it('hides my agent that lives in a group or a project, even with messages or a top-level task', () => {
    expect(show({ kind: 'dm', peer_user_id: 'a-room' }, true)).toBe(false)
    expect(show({ kind: 'ai', peer_user_id: 'a-project' }, true)).toBe(false)
  })

  it('shows my standalone agent; an empty DM only when the agent has a top-level task', () => {
    expect(show({ kind: 'dm', peer_user_id: 'a-solo' }, true)).toBe(true)
    expect(show({ kind: 'dm', peer_user_id: 'a-solo' }, false)).toBe(true)
    expect(show({ kind: 'dm', peer_user_id: 'a-idle' }, false)).toBe(false)
    expect(show({ kind: 'dm', peer_user_id: 'a-idle' }, true)).toBe(true)
  })
})

describe('projects without a conversation row keep their project row', () => {
  const bound: Record<string, string> = { reserved: 'chat-reserved', listed: 'chat-listed' }
  const groupOf = (id: string) => bound[id]
  const ids = ['listed', 'reserved', 'unbound', 'reading']
  const known = (id: string) => id !== 'reading'

  it('lists the projects whose group is not in the chat list or that have no group, once bindings are known', () => {
    expect(projectsWithoutGroupRow(ids, groupOf, known, new Set(['chat-listed']))).toEqual(['reserved', 'unbound'])
  })

  it('says nothing while the chat list has not loaded', () => {
    expect(projectsWithoutGroupRow(ids, groupOf, known, null)).toEqual([])
  })
})

describe('the chat list tells the sidebar which groups it has', () => {
  const chats = [chat({ id: 'room', kind: 'group' }), chat({ id: 'project', kind: 'group' }), chat({ id: 'topic', kind: 'topic', source_chat_id: 'room' }), chat({ id: 'dm' })]

  it('names every group once the list has loaded', () => {
    expect([...(sidebarChatSignals(chats, new Set(['project'])).listedGroups ?? [])].sort()).toEqual(['project', 'room'])
  })

  it('names none (null) while it is loading', () => {
    expect(sidebarChatSignals(chats, new Set(['project']), null, false).listedGroups).toBeNull()
  })
})
