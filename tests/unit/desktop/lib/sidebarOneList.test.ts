import { describe, expect, it } from 'vitest'
import type { SessionpageProjectSummary, SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import {
  agentHasOwnRow,
  agentsInRooms,
  agentTaskHomes,
  accountProjectReading,
  oneListAgentRows,
  oneListProjectLines,
  oneListShows,
  oneListTail,
  placeProjectLines,
  sampleProjectLastLine,
  type AgentHomes,
} from '../../../../apps/desktop/src/lib/sidebarOneList'
import { zhCNSampleProject } from '../../../../apps/desktop/src/session/renderer/features/sample-project/content/zh-CN'
import { enUSSampleProject } from '../../../../apps/desktop/src/session/renderer/features/sample-project/content/en-US'
import type { SampleProjectContent } from '../../../../apps/desktop/src/session/renderer/features/sample-project/content/types'
import { chat } from '../../../support/testHarness'

const project = (id: string, kind?: 'workspace'): SessionpageProjectSummary => ({ id, name: id, path: `/${id}`, ...(kind ? { kind } : {}) })
const session = (conversationId: string, projectId: string, agent: string | null, parent: string | null = null): SessionpageSessionSummary => ({
  conversationId, projectId, title: conversationId, harness: 'codex', runtime: 'acp', agentStatus: 'idle', lastInteractedAt: null,
  supported: true, parentConversationId: parent, agent: agent ? { userId: agent } : null,
})
const homes = (parts: Partial<Record<keyof AgentHomes, string[]>> = {}): AgentHomes => ({
  inRooms: new Set(parts.inRooms), inProjects: new Set(parts.inProjects), withTopLevelTask: new Set(parts.withTopLevelTask), pinned: new Set(parts.pinned),
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
  // The account project list: `app` on mac is a project; nothing else is.
  const accounts = accountProjectReading([{ bindings: [{ deviceId: 'mac', localProjectId: 'app' }] }], false)

  it('a session in an account project puts its agent in the project; the task workspace is not a project', () => {
    const { inProjects, withTopLevelTask } = agentTaskHomes([{
      deviceId: 'mac',
      projects: [project('app'), project('tasks', 'workspace')],
      sessions: [session('s1', 'app', 'a-project'), session('s2', 'tasks', 'a-solo'), session('s3', 'tasks', null)],
    }], accounts)
    expect([...inProjects]).toEqual(['a-project'])
    expect([...withTopLevelTask]).toEqual(['a-solo'])
  })

  it('a local project the account list does not hold is no project: its agent has a top-level task, wherever the machine lists it', () => {
    const { inProjects, withTopLevelTask } = agentTaskHomes([{
      deviceId: 'mac',
      projects: [project('app'), project('fresh')],
      sessions: [session('s1', 'app', 'a-project'), session('s2', 'fresh', 'a-unpublished')],
    }], accounts)
    expect([...inProjects]).toEqual(['a-project'])
    expect([...withTopLevelTask]).toEqual(['a-unpublished'])
  })

  it('on the account list\'s first read, with nothing in hand, a machine\'s own projects count; its task workspace does not', () => {
    const { inProjects, withTopLevelTask } = agentTaskHomes([{
      deviceId: 'mac',
      projects: [project('app'), project('tasks', 'workspace')],
      sessions: [session('s1', 'app', 'a-project'), session('s2', 'tasks', 'a-solo')],
    }], accountProjectReading([], true))
    expect([...inProjects]).toEqual(['a-project'])
    expect([...withTopLevelTask]).toEqual(['a-solo'])
  })

  it('a fork is never a top-level task, also when its parent is on no machine we see', () => {
    const { withTopLevelTask, onlyForks } = agentTaskHomes([{
      deviceId: 'mac',
      projects: [project('tasks', 'workspace')],
      sessions: [session('root', 'tasks', 'a-root'), session('fork', 'tasks', 'a-fork', 'root'), session('orphan', 'tasks', 'a-orphan', 'archived')],
    }], accounts)
    expect([...withTopLevelTask]).toEqual(['a-root'])
    expect([...onlyForks].sort()).toEqual(['a-fork', 'a-orphan'])
  })

  it('an agent with a top-level task and a fork is not only a fork; one without any session is neither', () => {
    const { onlyForks } = agentTaskHomes([{
      deviceId: 'mac',
      projects: [project('tasks', 'workspace')],
      sessions: [session('root', 'tasks', 'a-both'), session('fork', 'tasks', 'a-both', 'root'), session('loose', 'tasks', null, 'root')],
    }], accounts)
    expect([...onlyForks]).toEqual([])
  })

  it('reads each machine\'s local projects against that machine\'s bindings', () => {
    const { inProjects, withTopLevelTask } = agentTaskHomes([
      { deviceId: 'mac', projects: [project('app')], sessions: [session('s1', 'app', 'a-1')] },
      { deviceId: 'pc', projects: [project('app')], sessions: [session('s2', 'app', 'a-2')] },
    ], accounts)
    expect([...inProjects]).toEqual(['a-1'])
    expect([...withTopLevelTask]).toEqual(['a-2'])
  })

  it('a fork on another machine still hangs under its parent', () => {
    const { withTopLevelTask } = agentTaskHomes([
      { deviceId: 'mac', projects: [project('tasks', 'workspace')], sessions: [session('root', 'tasks', 'a-root')] },
      { deviceId: 'pc', projects: [project('tasks2', 'workspace')], sessions: [session('fork', 'tasks2', 'a-fork', 'root')] },
    ], accounts)
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

  it('#2574 a standalone agent with sub-agents keeps one row; its sub-agents (and theirs) have none, they are in its inner column', () => {
    const tasks = agentTaskHomes([{
      deviceId: 'mac',
      projects: [project('tasks', 'workspace')],
      sessions: [session('solo', 'tasks', 'a-boss'), session('sub', 'tasks', 'a-sub', 'solo'), session('grandchild', 'tasks', 'a-grandchild', 'sub')],
    }], accountProjectReading([], false))
    const family = { ...tasks, inRooms: new Set<string>(), pinned: new Set<string>() }
    const mineToo = (id: string) => ['a-boss', 'a-sub', 'a-grandchild'].includes(id)
    expect(oneListShows(chat({ kind: 'dm', peer_user_id: 'a-boss' }), false, family, mineToo)).toBe(true)
    expect(oneListShows(chat({ kind: 'dm', peer_user_id: 'a-sub' }), true, family, mineToo)).toBe(false)
    expect(oneListShows(chat({ kind: 'ai', peer_user_id: 'a-grandchild' }), true, family, mineToo)).toBe(false)
  })
})

describe('#2574 the agent rows the list draws are what the task page opens an agent column on', () => {
  const identities = { 'a-solo': { display_name: 'Solo', avatar: 'https://example.test/solo.png', created_at: '2026-11-01T00:00:00Z' } }
  const drawn = [
    chat({ id: 'dm-solo', kind: 'dm', peer_user_id: 'a-solo' }),
    chat({ id: 'dm-pinned', kind: 'ai', peer_user_id: 'a-room' }),
    chat({ id: 'dm-person', kind: 'dm', peer_user_id: 'human' }),
    chat({ id: 'room', kind: 'group' }),
  ]

  it('names my agents drawn as rows of their own, with the name and face that row shows; a pinned agent\'s row, people and groups are none', () => {
    const rows = oneListAgentRows(drawn, new Map([['dm-pinned', {}]]), owns, identities)
    expect([...rows]).toEqual([['a-solo', { chatId: 'dm-solo', name: 'Solo', avatar: 'https://example.test/solo.png', createdAt: '2026-11-01T00:00:00Z' }]])
  })

  it('an alias on the row wins, as on the row itself; an agent the list does not draw has no row here', () => {
    const rows = oneListAgentRows([chat({ id: 'dm-solo', kind: 'dm', peer_user_id: 'a-solo', peer_alias: 'My Solo' })], new Map(), owns, identities)
    expect(rows.get('a-solo')?.name).toBe('My Solo')
    expect(oneListAgentRows([], new Map(), owns, identities).size).toBe(0)
  })
})

describe('an account project without a conversation row stands among the conversations at its time', () => {
  const at = (minute: number) => `2026-11-13T00:${String(minute).padStart(2, '0')}:00.000Z`
  const projects = [
    { chatId: 'chat-listed', archived: false, activeAt: at(9) },
    { chatId: 'chat-reserved', archived: false, activeAt: at(3) },
    { chatId: 'chat-new', archived: false, activeAt: at(8) },
    { chatId: 'chat-dissolved', archived: true, activeAt: at(7) },
  ]
  const chats = [chat({ id: 'chat-listed', kind: 'group' }), chat({ id: 'chat-reserved', kind: 'dm' }), chat({ id: 'room', kind: 'group' })]

  it('the account projects (not archived) whose group is not a group of the chat list, with the time its row will have', () => {
    expect(oneListProjectLines(projects, chats, new Set())).toEqual([
      { projectChatId: 'chat-reserved', activeAt: at(3) },
      { projectChatId: 'chat-new', activeAt: at(8) },
    ])
  })

  // Dissolving: the chat list reads the group archived and drops it before the account list reads the dissolve.
  it('a project whose group the chat list has read as archived is no row, whatever the account list still says', () => {
    expect(oneListProjectLines(projects, chats, new Set(['chat-new']))).toEqual([{ projectChatId: 'chat-reserved', activeAt: at(3) }])
  })

  const rows = [{ id: 'dm', at: 9 }, { id: 'room', at: 5 }, { id: 'old', at: 1 }]
  const activityOf = (row: { at: number }) => Date.parse(at(row.at))
  const order = (placed: readonly object[]) => placed.map((row) => ('projectChatId' in row ? row.projectChatId : (row as { id: string }).id))

  it('goes before the first conversation that is older, newest first; on an equal time after the conversation', () => {
    expect(order(placeProjectLines(rows, activityOf, [{ projectChatId: 'p3', activeAt: at(3) }, { projectChatId: 'p8', activeAt: at(8) }])))
      .toEqual(['dm', 'p8', 'room', 'p3', 'old'])
    expect(order(placeProjectLines(rows, activityOf, [{ projectChatId: 'p5', activeAt: at(5) }]))).toEqual(['dm', 'room', 'p5', 'old'])
    expect(order(placeProjectLines(rows, activityOf, [{ projectChatId: 'p0', activeAt: at(0) }]))).toEqual(['dm', 'room', 'old', 'p0'])
    expect(order(placeProjectLines([], activityOf, [{ projectChatId: 'p0', activeAt: at(0) }]))).toEqual(['p0'])
  })

  // A list the previous client cached has no time for its projects: none is made up, they wait after every row.
  it('a project whose time is not known yet goes after every row and every timed project, in the account list\'s order', () => {
    const lines = [{ projectChatId: 'unknown-b', activeAt: null }, { projectChatId: 'p8', activeAt: at(8) }, { projectChatId: 'unknown-a', activeAt: null }, { projectChatId: 'p0', activeAt: at(0) }]
    expect(order(placeProjectLines(rows, activityOf, lines))).toEqual(['dm', 'p8', 'room', 'old', 'p0', 'unknown-b', 'unknown-a'])
  })

  // The bug (owner's recording, 11-13): a new project's row was drawn after every conversation, then jumped to the top
  // when its group reached the chat list. Its group's row sorts by the same time, so it takes the same place.
  it('a new project stands where its group\'s conversation row lands when the chat list gets it', () => {
    const created = { id: 'chat-new', at: 10 }
    const before = order(placeProjectLines(rows, activityOf, [{ projectChatId: 'chat-new', activeAt: at(created.at) }]))
    const after = order([created, ...rows].sort((a, b) => activityOf(b) - activityOf(a)))
    expect(before).toEqual(['chat-new', 'dm', 'room', 'old'])
    expect(after).toEqual(before)
  })
})

describe('rows that never stand among the conversations come after every conversation row', () => {
  it('tasks with no agent identity first, the sample last', () => {
    expect(oneListTail([{ projectId: 'w', sessionId: 's' }], true)).toEqual([{ kind: 'task', projectId: 'w', sessionId: 's' }, { kind: 'sample' }])
  })

  it('whatever the sample says, it is not placed among the conversations', () => {
    expect(oneListTail([], true)).toEqual([{ kind: 'sample' }])
    expect(oneListTail([], false)).toEqual([])
  })
})

describe('the sample project row shows its transcript\'s last message', () => {
  it.each([['zh-CN', zhCNSampleProject], ['en-US', enUSSampleProject]] as const)('%s: "<sender>: <plain text>" and the time it shows', (_locale, content) => {
    const last = content.messages.at(-1)!
    const line = sampleProjectLastLine(content, 'Me')
    expect(line.time).toBe(last.time)
    // The bundled run ends on the agent's reply (as a group row's preview in the mock: 「Codex 6: 三份…」).
    expect(line.preview.startsWith(`${content.agent.name}: `)).toBe(true)
    expect(line.preview).not.toMatch(/\]\(https?:/)
    expect(line.preview.length).toBeGreaterThan(`${content.agent.name}: `.length)
  })

  const content = (messages: SampleProjectContent['messages']): SampleProjectContent => ({
    agent: { name: 'Codex', engine: 'codex' },
    messages,
    files: [{ id: 'f1', name: 'plan.md', mimeType: 'text/markdown', text: '', sha256: '' }],
    task: { startedAt: '09:00', endedAt: '09:00', steps: [] },
  })

  it('a last file message shows the file name after its sender', () => {
    expect(sampleProjectLastLine(content([{ id: 'm1', kind: 'file', from: 'agent', time: '09:00', file: 'f1' }]), 'Me')).toEqual({ preview: 'Codex: plan.md', time: '09:00' })
  })

  it('the person looking at it is the sender of their own lines and of the task card', () => {
    expect(sampleProjectLastLine(content([{ id: 'm1', kind: 'text', from: 'owner', time: '09:01', text: '**ok**' }]), 'Me').preview).toBe('Me: ok')
    expect(sampleProjectLastLine(content([{ id: 'm1', kind: 'task', time: '09:02', text: 'Plan a trip' }]), 'Me').preview).toBe('Me: Plan a trip')
  })

  it('fails loud on a transcript without messages, or on a file it does not carry', () => {
    expect(() => sampleProjectLastLine(content([]), 'Me')).toThrow()
    expect(() => sampleProjectLastLine(content([{ id: 'm1', kind: 'file', from: 'agent', time: '09:00', file: 'missing' }]), 'Me')).toThrow(/missing/)
  })
})
