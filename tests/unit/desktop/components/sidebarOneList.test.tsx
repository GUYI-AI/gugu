// @vitest-environment jsdom
// GUYI-AI/gugu#2548 the desktop sidebar as one list: the sidebar's chat list with the internal switch on and off.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatListPanel } from '../../../../apps/desktop/src/components/ChatListPanel'
import { publishSidebarChatView } from '../../../../apps/desktop/src/lib/sidebarChatsBridge'
import { installOwnedAgentEntry } from '../../../../apps/desktop/src/lib/ownedAgentConversation'
import { publishProjectGroupChats } from '../../../../apps/desktop/src/session/renderer/features/projects/stores/project-group-chats-bridge'
import { publishDirectoryDevices, removeDeviceSessions, updateDeviceSessions } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
import { installSessionViewRequestBridge } from '../../../../apps/desktop/src/session/renderer/features/sessions/stores/session-view-requests'
import { publishMyChatAgentCounts } from '../../../../apps/desktop/src/lib/innerSidebarBridge'
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
