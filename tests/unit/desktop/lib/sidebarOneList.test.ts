import { describe, expect, it } from 'vitest'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import {
  agentHasOwnRow,
  agentsInGroups,
  agentTaskHomes,
  oneListAgentRows,
  oneListShows,
  oneListTail,
  sampleProjectLastLine,
  type AgentHomes,
} from '../../../../apps/desktop/src/lib/sidebarOneList'
import { zhCNSampleProject } from '../../../../apps/desktop/src/session/renderer/features/sample-project/content/zh-CN'
import { enUSSampleProject } from '../../../../apps/desktop/src/session/renderer/features/sample-project/content/en-US'
import type { SampleProjectContent } from '../../../../apps/desktop/src/session/renderer/features/sample-project/content/types'
import { chat } from '../../../support/testHarness'
import { sidebarChatSignals } from '../../../../apps/desktop/src/lib/sidebarChatsBridge'

const session = (conversationId: string, projectId: string, agent: string | null, parent: string | null = null, bornInChatId: string | null = null): SessionpageSessionSummary => ({
  conversationId, projectId, title: conversationId, harness: 'codex', runtime: 'acp', agentStatus: 'idle', lastInteractedAt: null,
  supported: true, parentConversationId: parent, agent: agent ? { userId: agent } : null, bornInChatId,
})
const homes = (parts: Partial<Record<keyof AgentHomes, string[]>> = {}): AgentHomes => ({
  inGroups: new Set(parts.inGroups), withTopLevelTask: new Set(parts.withTopLevelTask), pinned: new Set(parts.pinned),
  onlyForks: new Set(parts.onlyForks),
})
const mine = new Set(['a-solo', 'a-room', 'a-project', 'a-idle', 'a-fork'])
const owns = (id: string) => mine.has(id)

describe('#2599 which agents live in a group: where they were created, not the groups they are members of', () => {
  const chats = [
    chat({ id: 'room', kind: 'group' }),
    chat({ id: 'shop-group', kind: 'group' }),
    chat({ id: 'room-topic', kind: 'topic', source_chat_id: 'room' }),
    chat({ id: 'dm', kind: 'dm' }),
  ]
  const bornIn = new Map<string, ReadonlySet<string | null>>([
    ['a-room', new Set(['room'])],
    ['a-shop', new Set(['shop-group'])],
    ['a-topic', new Set(['room-topic'])],
    ['a-two-groups', new Set(['room', 'shop-group'])],
    ['a-dm', new Set(['dm'])],
    ['a-button', new Set([null])],
    ['a-gone', new Set(['dissolved'])],
    ['a-left', new Set(['room-i-left'])],
  ])

  it('counts agents created in a group the list holds, topics (of their group) included', () => {
    expect([...agentsInGroups(chats, bornIn, new Set())].sort()).toEqual(['a-room', 'a-shop', 'a-topic', 'a-two-groups'])
  })

  it('a group that is gone (dissolved, read as archived, or left) is no home: its agents get their own row', () => {
    expect([...agentsInGroups(chats, bornIn, new Set(['room']))].sort()).toEqual(['a-shop'])
  })

  it('one top-level task created elsewhere keeps the agent its own row (that task has no other place to show)', () => {
    const mixed = new Map<string, ReadonlySet<string | null>>([
      ['a-room-and-button', new Set(['room', null])],
      ['a-room-and-dm', new Set(['room', 'dm'])],
    ])
    expect([...agentsInGroups(chats, mixed, new Set())]).toEqual([])
  })

  it('agentTaskHomes records where each top-level task was created; a fork records none', () => {
    const { groupsOf: born, withTopLevelTask } = agentTaskHomes([{
      sessions: [
        session('s1', 'tasks', 'a-room', null, 'room'),
        session('s3', 'tasks', 'a-button', null, null),
        session('s4', 'tasks', 'a-child', 's1', 'room'),
      ],
    }])
    expect(Object.fromEntries([...born].map(([agent, chats]) => [agent, [...chats]]))).toEqual({ 'a-room': ['room'], 'a-button': [null] })
    expect([...withTopLevelTask].sort()).toEqual(['a-button', 'a-room'])
  })
})

describe('which agents have a top-level task', () => {
  it('a fork is never a top-level task, also when its parent is on no machine we see', () => {
    const { withTopLevelTask, onlyForks } = agentTaskHomes([{
      sessions: [session('root', 'tasks', 'a-root'), session('fork', 'tasks', 'a-fork', 'root'), session('orphan', 'tasks', 'a-orphan', 'archived')],
    }])
    expect([...withTopLevelTask]).toEqual(['a-root'])
    expect([...onlyForks].sort()).toEqual(['a-fork', 'a-orphan'])
  })

  it('an agent with a top-level task and a fork is not only a fork; one without any session is neither', () => {
    const { onlyForks } = agentTaskHomes([{
      sessions: [session('root', 'tasks', 'a-both'), session('fork', 'tasks', 'a-both', 'root'), session('loose', 'tasks', null, 'root')],
    }])
    expect([...onlyForks]).toEqual([])
  })

  it('a fork on another machine still hangs under its parent', () => {
    const { withTopLevelTask } = agentTaskHomes([
      { sessions: [session('root', 'tasks', 'a-root')] },
      { sessions: [session('fork', 'tasks2', 'a-fork', 'root')] },
    ])
    expect([...withTopLevelTask]).toEqual(['a-root'])
  })
})

describe('an owned agent has its own row only when it lives in no group', () => {
  it.each([
    [homes(), true],
    [homes({ inGroups: ['a'] }), false],
    [homes({ withTopLevelTask: ['a'] }), true],
    [homes({ onlyForks: ['a'] }), false],
  ])('%#', (agentHomes, expected) => expect(agentHasOwnRow('a', agentHomes)).toBe(expected))
})

describe('what the one list shows', () => {
  const agentHomes = homes({ inGroups: ['a-room', 'a-project'], withTopLevelTask: ['a-solo', 'a-room'], onlyForks: ['a-fork'] })
  const show = (overrides: Parameters<typeof chat>[0], listed: boolean) => oneListShows(chat(overrides), listed, agentHomes, owns)

  it('never shows a topic as a row, listed or not', () => {
    expect(show({ kind: 'topic', source_chat_id: 'room' }, true)).toBe(false)
  })

  it('shows groups by the list rule', () => {
    expect(show({ kind: 'group' }, true)).toBe(true)
  })

  it('shows direct messages with people (and with other people\'s agents) by the list rule', () => {
    expect(show({ kind: 'dm', peer_user_id: 'human' }, true)).toBe(true)
    expect(show({ kind: 'dm', peer_user_id: 'human' }, false)).toBe(false)
    expect(show({ kind: 'dm', peer_user_id: 'someone-elses-agent' }, true)).toBe(true)
  })

  it('hides my agent that lives in a group, even with messages or a top-level task', () => {
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
      sessions: [session('solo', 'tasks', 'a-boss'), session('sub', 'tasks', 'a-sub', 'solo'), session('grandchild', 'tasks', 'a-grandchild', 'sub')],
    }])
    const family = { ...tasks, inGroups: new Set<string>(), pinned: new Set<string>() }
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

describe('#2569 the chat list tells the task page which groups it has', () => {
  const chats = [chat({ id: 'room', kind: 'group' }), chat({ id: 'project', kind: 'group' }), chat({ id: 'topic', kind: 'topic', source_chat_id: 'room' }), chat({ id: 'dm' })]

  it('names every group once the list has loaded', () => {
    expect([...(sidebarChatSignals(chats).listedGroups ?? [])].sort()).toEqual(['project', 'room'])
  })

  it('names none (null) while it is loading', () => {
    expect(sidebarChatSignals(chats, false).listedGroups).toBeNull()
  })
})
