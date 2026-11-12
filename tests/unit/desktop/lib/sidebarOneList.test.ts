import { describe, expect, it } from 'vitest'
import type { SessionpageProjectSummary, SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import {
  agentHasOwnRow,
  agentsInRooms,
  agentTaskHomes,
  oneListShows,
  oneListTail,
  projectsWithoutGroupRow,
  sampleProjectLastLine,
  type AgentHomes,
} from '../../../../apps/desktop/src/lib/sidebarOneList'
import { zhCNSampleProject } from '../../../../apps/desktop/src/session/renderer/features/sample-project/content/zh-CN'
import { enUSSampleProject } from '../../../../apps/desktop/src/session/renderer/features/sample-project/content/en-US'
import type { SampleProjectContent } from '../../../../apps/desktop/src/session/renderer/features/sample-project/content/types'
import { sidebarChatSignals } from '../../../../apps/desktop/src/lib/sidebarChatsBridge'
import { chat } from '../../../support/testHarness'

const project = (id: string, kind?: 'workspace'): SessionpageProjectSummary => ({ id, name: id, path: `/${id}`, ...(kind ? { kind } : {}) })
const session = (conversationId: string, projectId: string, agent: string | null, parent: string | null = null): SessionpageSessionSummary => ({
  conversationId, projectId, title: conversationId, harness: 'codex', runtime: 'acp', agentStatus: 'idle', lastInteractedAt: null,
  supported: true, parentConversationId: parent, agent: agent ? { userId: agent } : null,
})
const homes = (parts: Partial<Record<keyof AgentHomes, string[]>> = {}): AgentHomes => ({
  inRooms: new Set(parts.inRooms), inProjects: new Set(parts.inProjects), withTopLevelTask: new Set(parts.withTopLevelTask),
  onlyForks: new Set(parts.onlyForks),
})
const mine = new Set(['a-solo', 'a-room', 'a-project', 'a-idle', 'a-fork'])
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

  it('a fork is never a top-level task, also when its parent is on no machine we see', () => {
    const { withTopLevelTask, onlyForks } = agentTaskHomes([{
      projects: [project('tasks', 'workspace')],
      sessions: [session('root', 'tasks', 'a-root'), session('fork', 'tasks', 'a-fork', 'root'), session('orphan', 'tasks', 'a-orphan', 'archived')],
    }])
    expect([...withTopLevelTask]).toEqual(['a-root'])
    expect([...onlyForks].sort()).toEqual(['a-fork', 'a-orphan'])
  })

  it('an agent with a top-level task and a fork is not only a fork; one without any session is neither', () => {
    const { onlyForks } = agentTaskHomes([{
      projects: [project('tasks', 'workspace')],
      sessions: [session('root', 'tasks', 'a-both'), session('fork', 'tasks', 'a-both', 'root'), session('loose', 'tasks', null, 'root')],
    }])
    expect([...onlyForks]).toEqual([])
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
    [homes({ onlyForks: ['a'] }), false],
  ])('%#', (agentHomes, expected) => expect(agentHasOwnRow('a', agentHomes)).toBe(expected))
})

describe('what the one list shows', () => {
  const agentHomes = homes({ inRooms: ['a-room'], inProjects: ['a-project'], withTopLevelTask: ['a-solo', 'a-room'], onlyForks: ['a-fork'] })
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

  it('never shows my agent that only has forks: a fork stays under its parent, even when its DM has messages', () => {
    expect(show({ kind: 'dm', peer_user_id: 'a-fork' }, true)).toBe(false)
    expect(show({ kind: 'ai', peer_user_id: 'a-fork' }, false)).toBe(false)
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

describe('rows that are not a conversation yet come after every conversation row', () => {
  it('projects without a group chat first (in the sidebar\'s project order), the sample last', () => {
    expect(oneListTail(['p2', 'p1'], true)).toEqual([{ kind: 'project', projectId: 'p2' }, { kind: 'project', projectId: 'p1' }, { kind: 'sample' }])
  })

  it('has no time to sort by: whatever the sample says, it is not placed among the conversations', () => {
    expect(oneListTail([], true)).toEqual([{ kind: 'sample' }])
    expect(oneListTail([], false)).toEqual([])
    expect(oneListTail(['p'], false)).toEqual([{ kind: 'project', projectId: 'p' }])
  })
})

describe('the sample project row shows its transcript\'s last message', () => {
  it.each([['zh-CN', zhCNSampleProject], ['en-US', enUSSampleProject]] as const)('%s: plain text and the time it shows', (_locale, content) => {
    const last = content.messages.at(-1)!
    const line = sampleProjectLastLine(content)
    expect(line.time).toBe(last.time)
    expect(line.preview).not.toMatch(/\]\(https?:/)
    expect(line.preview.length).toBeGreaterThan(0)
  })

  it('a last file message shows the file name', () => {
    const content: SampleProjectContent = {
      agent: { name: 'Codex', engine: 'codex' },
      messages: [{ id: 'm1', kind: 'file', from: 'agent', time: '09:00', file: 'f1' }],
      files: [{ id: 'f1', name: 'plan.md', mimeType: 'text/markdown', text: '', sha256: '' }],
      task: { startedAt: '09:00', endedAt: '09:00', steps: [] },
    }
    expect(sampleProjectLastLine(content)).toEqual({ preview: 'plan.md', time: '09:00' })
  })

  it('fails loud on a transcript without messages', () => {
    expect(() => sampleProjectLastLine({ agent: { name: 'Codex', engine: 'codex' }, messages: [], files: [], task: { startedAt: '', endedAt: '', steps: [] } })).toThrow()
  })
})
