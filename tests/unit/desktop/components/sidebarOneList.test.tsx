// @vitest-environment jsdom
// GUYI-AI/gugu#2548 the desktop sidebar as one list: the sidebar's chat list with the internal switch on and off.
import { runInAction } from 'mobx'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatListPanel } from '../../../../apps/desktop/src/components/ChatListPanel'
import { oneListProjectSlotKey, publishSidebarChatView } from '../../../../apps/desktop/src/lib/sidebarChatsBridge'
import { installShellSlots, readShellSlots } from '../../../../apps/desktop/src/lib/shellSlots'
import { blockKey } from '../../../../apps/desktop/src/lib/sidebarJoinedGroups'
import { forgetArchivedGroups, noteGroupArchived } from '../../../../apps/desktop/src/lib/archivedGroupsRead'
import { installOwnedAgentEntry } from '../../../../apps/desktop/src/lib/ownedAgentConversation'
import { publishProjectGroupChats } from '../../../../apps/desktop/src/session/renderer/features/projects/stores/project-group-chats-bridge'
import { publishDirectoryDevices, removeDeviceSessions, updateDeviceSessions } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
import { installSessionViewRequestBridge } from '../../../../apps/desktop/src/session/renderer/features/sessions/stores/session-view-requests'
import { publishMyChatAgentCounts } from '../../../../apps/desktop/src/lib/innerSidebarBridge'
import { accountProjectsStore } from '../../../../apps/desktop/src/session/renderer/features/projects/stores/account-projects-store'
import { chat, clickElement, createNode, createReactHarness, device, displayIdentity, renderWithAppProviders } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/platform', () => import('../../../support/capacitorPlatformTestDouble'))
vi.mock('../../../../apps/desktop/src/hooks/useAgentDisplayStatus', async () => ({
  ...await import('../../../support/agentDisplayStatusTestDouble'),
  useAgentDisplayStatuses: () => ({}),
}))

// jsdom has no layout: give the document (the sidebar list's scroller here) a window's height, so the sidebar's
// virtualized conversation lines (@@@sidebar-chat-window) mount the lines that would fit, as on screen.
beforeEach(() => {
  for (const [key, value] of [['offsetHeight', 900], ['offsetWidth', 1024]] as const) Object.defineProperty(document.documentElement, key, { configurable: true, get: () => value })
})

const mine = new Set(['a-room', 'a-project', 'a-solo', 'a-idle', 'a-fork'])
const openChat = vi.fn()
const openAgent = vi.fn((_chatId: string | undefined, _peerId?: string) => true)
let harness: ReturnType<typeof createReactHarness>
let release: () => void
beforeEach(() => {
  harness = createReactHarness()
  openChat.mockReset()
  openAgent.mockClear()
  installSessionViewRequestBridge(window, { openChat })
  release = installOwnedAgentEntry({ owns: (id) => mine.has(id), open: openAgent })
  publishProjectGroupChats(['project'], new Map(), new Map())
  publishDirectoryDevices([device('mac', [])])
  updateDeviceSessions('mac', {
    projects: [{ id: 'app', name: 'App', path: '/app' }, { id: 'tasks', name: '', path: '/tasks', kind: 'workspace' }],
    sessions: [
      { conversationId: 's-project', projectId: 'app', title: 'Fix', harness: 'codex', runtime: 'acp', agentStatus: 'idle', lastInteractedAt: null, supported: true, agent: { userId: 'a-project' } },
      { conversationId: 's-solo', projectId: 'tasks', title: 'Solo', harness: 'codex', runtime: 'acp', agentStatus: 'idle', lastInteractedAt: null, supported: true, agent: { userId: 'a-solo' } },
      { conversationId: 's-fork', projectId: 'tasks', title: 'Fork', harness: 'codex', runtime: 'acp', agentStatus: 'idle', lastInteractedAt: null, supported: true, parentConversationId: 's-solo', agent: { userId: 'a-fork' } },
    ],
    cached: false, loading: false,
  })
})
afterEach(() => {
  harness.cleanup()
  release()
  publishSidebarChatView({ focusedChatId: null, groups: [] })
  publishProjectGroupChats([], new Map(), new Map())
  publishDirectoryDevices([])
  removeDeviceSessions('mac')
})

const at = (day: number) => `2099-01-0${day}T00:00:00Z`
const chats = [
  chat({ id: 'room', kind: 'group', name: 'Room', member_user_ids: ['me', 'a-room'], last_message_at: at(5) }),
  chat({ id: 'room-topic', kind: 'topic', name: 'Review', source_chat_id: 'room', last_message_at: at(6) }),
  chat({ id: 'project', kind: 'group', name: 'App', member_user_ids: ['me'], last_message_at: at(4) }),
  chat({ id: 'dm-human', peer_user_id: 'human', last_message_at: at(3) }),
  chat({ id: 'dm-room-agent', peer_user_id: 'a-room', last_message_at: at(7) }),
  chat({ id: 'dm-project-agent', peer_user_id: 'a-project', last_message_at: at(2) }),
  chat({ id: 'dm-solo', peer_user_id: 'a-solo', created_at: at(1) }),
  chat({ id: 'dm-idle', peer_user_id: 'a-idle', created_at: at(1) }),
  chat({ id: 'dm-fork', peer_user_id: 'a-fork', last_message_at: at(8) }),
]
const identitiesById = {
  me: displayIdentity('me'),
  human: displayIdentity('human'),
  ...Object.fromEntries([...mine].map((id) => [id, displayIdentity(id, { type: 'agent', owner_user_id: 'me' })])),
}
const render = () => renderWithAppProviders(harness, createNode(ChatListPanel, { placement: 'sidebar' }), { chat: { chats, identitiesById }, contacts: {} })
const rows = () => [...harness.container.querySelectorAll<HTMLElement>('[data-chat-row]')].map((row) => row.dataset.chatRow)

describe('the sidebar chat list as one list', () => {
  it('switch off: today\'s Chats tab (project groups out, topics nested, empty DMs out)', async () => {
    publishSidebarChatView({ focusedChatId: null, groups: [] })
    await render()
    expect(rows()).toEqual(['dm-fork', 'dm-room-agent', 'room', 'room-topic', 'dm-human', 'dm-project-agent'])
  })

  it('switch on: standalone agents, groups, project groups and people, by activity; no topics; agents living elsewhere and forks have no row', async () => {
    publishSidebarChatView({ focusedChatId: null, groups: [], oneList: true })
    await render()
    expect(rows()).toEqual(['room', 'project', 'dm-human', 'dm-solo'])
    expect(harness.container.querySelector('[data-topic-subrow]')).toBeNull()
  })

  it('switch on: a row is a place to open, ❌ dragged beside to split (switch off it still drags, as today)', async () => {
    const draggable = () => [...harness.container.querySelectorAll<HTMLElement>('[data-chat-row]')].map((row) => row.getAttribute('draggable'))
    publishSidebarChatView({ focusedChatId: null, groups: [] })
    await render()
    expect(new Set(draggable())).toEqual(new Set(['true']))
    publishSidebarChatView({ focusedChatId: null, groups: [], oneList: true })
    await render()
    expect(new Set(draggable())).toEqual(new Set(['false']))
  })

  it('switch on: a project row opens through the existing chat route (the task page turns a project group into its project block); an agent row opens its session', async () => {
    publishSidebarChatView({ focusedChatId: null, groups: [], oneList: true })
    await render()
    await clickElement(harness.container.querySelector<HTMLElement>('[data-chat-row="project"]')!)
    expect(openChat).toHaveBeenCalledWith('project', false)
    await clickElement(harness.container.querySelector<HTMLElement>('[data-chat-row="dm-solo"]')!)
    expect(openAgent).toHaveBeenCalledWith('dm-solo', 'a-solo', undefined, undefined, undefined)
    expect(openChat).toHaveBeenCalledTimes(1)
  })

  it('switch on, collapsed to the rail: a project row\'s running count is on its avatar, the part of the row the rail keeps', async () => {
    publishSidebarChatView({ focusedChatId: null, groups: [], oneList: true })
    publishMyChatAgentCounts(new Map([['project', { total: 3, running: 2 }]]))
    try {
      await render()
      const badge = harness.container.querySelector<HTMLElement>('[data-chat-row="project"] [data-project-running]')!
      expect(badge.dataset.projectRunning).toBe('2')
      // The rail fades each row's text (left-sidebar.tsx, inside .gg-list-row-body); the avatar column is .gg-list-row-leading.
      expect(badge.closest('.gg-list-row-leading')).not.toBeNull()
      expect(badge.closest('.gg-list-row-body')).toBeNull()
    } finally {
      await act(async () => publishMyChatAgentCounts(new Map()))
    }
  })
})

describe('#2548 an account project whose group is not in the chat list yet stands among the conversation rows at its time', () => {
  const newProject = (activeAt: string) => ({ chatId: 'new-project', name: 'Blink', archived: false, activeAt, bindings: [] })
  // The project whose group is listed ('project', mac's 'app'): its agent lives there, as on the first read above.
  const app = { chatId: 'project', name: 'App', archived: false, activeAt: at(4), bindings: [{ deviceId: 'mac', localProjectId: 'app' }] }
  /** The lines of the list, top to bottom: a conversation row, or the place left for a project row. */
  const lines = () => [...harness.container.querySelectorAll<HTMLElement>('[data-chat-row], [data-one-list-project]')]
    .map((line) => line.dataset.oneListProject ? `place:${line.dataset.oneListProject}` : line.dataset.chatRow)
  installShellSlots()
  const slots = () => readShellSlots()!.getSlots()
  afterEach(() => accountProjectsStore.clear())

  // The owner's recording (11-13): 新建空白项目 drew the new project after every conversation, and ~200 ms later, when its
  // group reached the chat list, the row jumped to the top. The account project list says when its group was last active
  // (list_my_projects: last message, else creation), the time its conversation row sorts by.
  it('a new project stands where its group\'s conversation row then lands, and that row takes the same place', async () => {
    publishSidebarChatView({ focusedChatId: null, groups: [], oneList: true })
    const created = '2099-01-04T12:00:00Z'
    runInAction(() => {
      accountProjectsStore.list = [app, newProject(created)]
      accountProjectsStore.status = 'ready'
    })
    await render()
    expect(lines()).toEqual(['room', 'place:new-project', 'project', 'dm-human', 'dm-solo'])
    // The task page draws the project's row into that place (sidebar-one-list).
    expect(slots().get(oneListProjectSlotKey('new-project'))).toBe(harness.container.querySelector('[data-one-list-project="new-project"]'))

    // Its group reaches the chat list: the conversation row is in the same place, and the place for the project row is gone.
    await renderWithAppProviders(harness, createNode(ChatListPanel, { placement: 'sidebar' }), {
      chat: { chats: [...chats, chat({ id: 'new-project', kind: 'group', name: 'Blink', member_user_ids: ['me'], created_at: created })], identitiesById },
      contacts: {},
    })
    expect(lines()).toEqual(['room', 'new-project', 'project', 'dm-human', 'dm-solo'])
    expect(slots().has(oneListProjectSlotKey('new-project'))).toBe(false)
  })

  // Opened beside another block before its conversation arrives: the box holds the project's place as it will hold the
  // conversation row (one key), so nothing snaps into the box when the conversation lands.
  it('a joined box holds the project\'s place as it holds its conversation row once that arrives', async () => {
    const box = { members: [blockKey.chat('room'), blockKey.chat('new-project')], onScreen: true }
    publishSidebarChatView({ focusedChatId: null, groups: [box], oneList: true })
    const created = '2099-01-02T12:00:00Z'
    runInAction(() => {
      accountProjectsStore.list = [app, newProject(created)]
      accountProjectsStore.status = 'ready'
    })
    await render()
    expect(lines()).toEqual(['room', 'place:new-project', 'project', 'dm-human', 'dm-solo'])
    expect(harness.container.querySelector<HTMLElement>('[data-one-list-project="new-project"]')!.dataset.join).toBe('last')

    await renderWithAppProviders(harness, createNode(ChatListPanel, { placement: 'sidebar' }), {
      chat: { chats: [...chats, chat({ id: 'new-project', kind: 'group', name: 'Blink', member_user_ids: ['me'], created_at: created })], identitiesById },
      contacts: {},
    })
    expect(lines()).toEqual(['room', 'new-project', 'project', 'dm-human', 'dm-solo'])
    expect(harness.container.querySelector<HTMLElement>('[data-chat-row="new-project"]')!.dataset.join).toBe('last')
  })

  // The owner's recording of a dissolve (11-13): the chat list dropped the group, and the project's row stayed until the
  // account list was read again. The chat list read the group archived (or this account archived it): no row at once.
  it('a project group the chat list has read as archived leaves no project place behind, before the account list knows', async () => {
    publishSidebarChatView({ focusedChatId: null, groups: [], oneList: true })
    runInAction(() => {
      accountProjectsStore.list = [app]
      accountProjectsStore.status = 'ready'
    })
    const dissolved = chats.filter((row) => row.id !== 'project')
    try {
      noteGroupArchived('project', true)
      await renderWithAppProviders(harness, createNode(ChatListPanel, { placement: 'sidebar' }), { chat: { chats: dissolved, identitiesById }, contacts: {} })
      expect(lines()).toEqual(['room', 'dm-human', 'dm-solo'])
    } finally {
      forgetArchivedGroups()
    }
  })

  it('a project created a moment ago stands at the top; a dissolved one stands nowhere; switch off: no project places', async () => {
    publishSidebarChatView({ focusedChatId: null, groups: [], oneList: true })
    runInAction(() => {
      accountProjectsStore.list = [app, newProject('2099-02-01T00:00:00Z'), { ...newProject('2099-01-06T00:00:00Z'), chatId: 'dissolved', archived: true }]
      accountProjectsStore.status = 'ready'
    })
    await render()
    expect(lines()).toEqual(['place:new-project', 'room', 'project', 'dm-human', 'dm-solo'])
    publishSidebarChatView({ focusedChatId: null, groups: [] })
    await render()
    expect(lines().filter((line) => line?.startsWith('place:'))).toEqual([])
  })
})

describe('#2548 the one list\'s unread marks: a red number for what calls you, a grey dot for other news', () => {
  // `count` unread, of which `addressed` call me (the server's addressed_count: a mention of me, @所有人, a reply to me).
  const locator = (id: string, count: number, addressed: number) => ({
    unread_count: count,
    unread_locator: { stream_id: `main:${id}`, stream_kind: 'main' as const, thread_root_id: null, message_id: `${id}-1`, message_seq: 1,
      unread_count: count, addressed_count: addressed, cursor_seq: 0, version: 1, is_marked_unread: false },
  })
  const unreadChats = [
    chat({ id: 'called', kind: 'group', name: 'Called', member_user_ids: ['me'], last_message_at: at(8), ...locator('called', 2, 0) }),
    chat({ id: 'called-topic', kind: 'topic', name: 'Pricing', source_chat_id: 'called', last_message_at: at(8), ...locator('called-topic', 4, 1) }),
    chat({ id: 'plain', kind: 'group', name: 'Plain', member_user_ids: ['me'], last_message_at: at(7), ...locator('plain', 5, 0) }),
    chat({ id: 'named', kind: 'group', name: 'Named', member_user_ids: ['me'], last_message_at: at(6), ...locator('named', 5, 2) }),
    chat({ id: 'dm-human', peer_user_id: 'human', last_message_at: at(5), ...locator('dm-human', 3, 0) }),
  ]
  const renderUnread = (props: Record<string, unknown>) => renderWithAppProviders(harness, createNode(ChatListPanel, props), { chat: { chats: unreadChats, identitiesById }, contacts: {} })
  const marks = () => Object.fromEntries([...harness.container.querySelectorAll<HTMLElement>('[data-chat-row]')].map((row) => [row.dataset.chatRow,
    [...row.querySelectorAll<HTMLElement>('.gg-list-row-trailing [data-slot="chip"]')].map((chip) => chip.dataset.shape === 'dot' ? 'dot' : `${chip.dataset.tone}:${chip.textContent}`)]))

  it('desktop: a group counts its main chat\'s calls plus its topics\' calls; a DM counts every message; other news is a dot', async () => {
    publishSidebarChatView({ focusedChatId: null, groups: [], oneList: true })
    await renderUnread({ placement: 'sidebar' })
    expect(marks()).toEqual({ called: ['danger:1'], plain: ['dot'], named: ['danger:2'], 'dm-human': ['danger:3'] })
  })

  it('the phone is unchanged: its row counts its main chat whole plus its topics\' calls, in today\'s chip, never a dot', async () => {
    publishSidebarChatView({ focusedChatId: null, groups: [] })
    await renderUnread({ mobile: true })
    expect(marks()).toEqual({ called: ['accent:3'], plain: ['accent:5'], named: ['accent:5'], 'dm-human': ['accent:3'] })
  })
})
