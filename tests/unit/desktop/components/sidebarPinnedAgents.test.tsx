// @vitest-environment jsdom
// GUYI-AI/gugu#2548 固定到左侧栏 in the one list: the task page publishes my pinned agents; the sidebar's chat list puts
// their DM rows on top, says where each lives, and offers 取消固定到左侧栏 on them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatListPanel } from '../../../../apps/desktop/src/components/ChatListPanel'
import { publishSidebarChatView, publishSidebarPinnedAgents, type SidebarPinnedAgent } from '../../../../apps/desktop/src/lib/sidebarChatsBridge'
import { installOwnedAgentEntry } from '../../../../apps/desktop/src/lib/ownedAgentConversation'
import { publishProjectGroupChats } from '../../../../apps/desktop/src/session/renderer/features/projects/stores/project-group-chats-bridge'
import { publishDirectoryDevices, removeDeviceSessions, updateDeviceSessions } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
import { installSessionViewRequestBridge } from '../../../../apps/desktop/src/session/renderer/features/sessions/stores/session-view-requests'
import { chat, clickElement, createNode, createReactHarness, device, displayIdentity, fireContextMenu, renderWithAppProviders } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/platform', () => import('../../../support/capacitorPlatformTestDouble'))
vi.mock('../../../../apps/desktop/src/hooks/useAgentDisplayStatus', async () => ({
  ...await import('../../../support/agentDisplayStatusTestDouble'),
  useAgentDisplayStatuses: () => ({}),
}))

// jsdom has no layout: give the sidebar list's scroller a window's height so its virtualized lines mount (@@@sidebar-chat-window).
beforeEach(() => {
  for (const [key, value] of [['offsetHeight', 900], ['offsetWidth', 1024]] as const) Object.defineProperty(document.documentElement, key, { configurable: true, get: () => value })
})

const mine = new Set(['a-room', 'a-project', 'a-solo', 'a-nodm'])
const unpinFromSidebar = vi.fn()
const openSidebarPin = vi.fn()
const openAgent = vi.fn(() => true)
let harness: ReturnType<typeof createReactHarness>
let release: () => void
beforeEach(() => {
  harness = createReactHarness()
  unpinFromSidebar.mockReset()
  openSidebarPin.mockReset()
  openAgent.mockClear()
  installSessionViewRequestBridge(window, { openChat: vi.fn(), unpinFromSidebar, openSidebarPin })
  release = installOwnedAgentEntry({ owns: (id) => mine.has(id), open: openAgent })
  publishProjectGroupChats(['project'], new Map(), new Map())
  publishDirectoryDevices([device('mac', [])])
  updateDeviceSessions('mac', {
    projects: [{ id: 'app', name: 'App', path: '/app' }, { id: 'tasks', name: '', path: '/tasks', kind: 'workspace' }],
    sessions: [
      { conversationId: 's-project', projectId: 'app', title: 'Fix', harness: 'codex', runtime: 'acp', agentStatus: 'idle', lastInteractedAt: null, supported: true, agent: { userId: 'a-project' } },
      { conversationId: 's-solo', projectId: 'tasks', title: 'Solo', harness: 'codex', runtime: 'acp', agentStatus: 'idle', lastInteractedAt: null, supported: true, agent: { userId: 'a-solo' } },
      // #2599 a-room was created in Room, so it lives there: only a pin gives it a row of its own.
      { conversationId: 's-room', projectId: 'tasks', title: 'Room task', harness: 'codex', runtime: 'acp', agentStatus: 'idle', lastInteractedAt: null, supported: true, agent: { userId: 'a-room' }, bornInChatId: 'room' },
    ],
    cached: false, loading: false,
  })
})
afterEach(() => {
  harness.cleanup()
  release()
  publishSidebarChatView({ focusedChatId: null, groups: [] })
  publishSidebarPinnedAgents([])
  publishProjectGroupChats([], new Map(), new Map())
  publishDirectoryDevices([])
  removeDeviceSessions('mac')
})

const at = (day: number) => `2099-01-0${day}T00:00:00Z`
const chats = [
  chat({ id: 'room', kind: 'group', name: 'Room', member_user_ids: ['me', 'a-room'], last_message_at: at(5) }),
  chat({ id: 'project', kind: 'group', name: 'App', member_user_ids: ['me'], last_message_at: at(4) }),
  chat({ id: 'dm-human', peer_user_id: 'human', last_message_at: at(3) }),
  chat({ id: 'dm-room-agent', peer_user_id: 'a-room', last_message_at: at(7), last_message_preview: 'Report ready' }),
  // Pinned, and its DM has no message yet: the pinned session is the conversation.
  chat({ id: 'dm-project-agent', peer_user_id: 'a-project', created_at: at(1) }),
  chat({ id: 'dm-solo', peer_user_id: 'a-solo', created_at: at(1) }),
]
const identitiesById = {
  me: displayIdentity('me'),
  human: displayIdentity('human'),
  ...Object.fromEntries([...mine].map((id) => [id, displayIdentity(id, { type: 'agent', owner_user_id: 'me' })])),
}
// Newest interaction first (the task page's order), not the DMs' activity; a-nodm has no DM chat.
const pins: SidebarPinnedAgent[] = [
  { agentUserId: 'a-project', sessionId: 's-project', home: { kind: 'project', name: 'App', chatId: 'project' } },
  { agentUserId: 'a-nodm', sessionId: 's-nodm', home: { kind: 'group', name: 'Room', chatId: 'room' } },
  { agentUserId: 'a-room', sessionId: 's-room', home: { kind: 'group', name: 'Room', chatId: 'room' } },
]
const render = () => renderWithAppProviders(harness, createNode(ChatListPanel, { placement: 'sidebar' }), { auth: { id: 'me' }, chat: { chats, identitiesById }, contacts: {} })
const rows = () => [...harness.container.querySelectorAll<HTMLElement>('[data-chat-row]')].map((row) => row.dataset.chatRow)
const row = (id: string) => harness.container.querySelector<HTMLElement>(`[data-chat-row="${id}"]`)!
const unpinItem = async (id: string) => {
  await fireContextMenu(row(id))
  return document.querySelector<HTMLElement>('[data-testid="conversation-row-unpin-from-sidebar"]')
}

describe('agents pinned to the one list', () => {
  it('switch on: their DM rows come first in the published order, above everything else, and say where each lives', async () => {
    publishSidebarChatView({ focusedChatId: null, groups: [], oneList: true })
    publishSidebarPinnedAgents(pins)
    await render()
    expect(rows()).toEqual(['dm-project-agent', 'dm-room-agent', 'room', 'project', 'dm-human', 'dm-solo'])
    expect(row('dm-room-agent').textContent).toContain('Room · Report ready')
    expect(row('dm-project-agent').textContent).toContain('App')
    expect(row('dm-solo').textContent).not.toContain(' · ')
    // The sidebar glyph before the time marks the pinned rows only.
    expect(row('dm-room-agent').querySelector('.gg-list-row-meta svg')).not.toBeNull()
    expect(row('dm-solo').querySelector('.gg-list-row-meta svg')).toBeNull()
  })

  it('switch on: clicking a pinned row opens the group / project it lives in (the agent selected there), not its DM', async () => {
    publishSidebarChatView({ focusedChatId: null, groups: [], oneList: true })
    publishSidebarPinnedAgents(pins)
    await render()
    await clickElement(row('dm-room-agent'))
    expect(openSidebarPin).toHaveBeenCalledWith('s-room', 'room')
    expect(openAgent).not.toHaveBeenCalled()
    await clickElement(row('dm-solo'))
    expect(openAgent).toHaveBeenCalledTimes(1)
    expect(openSidebarPin).toHaveBeenCalledTimes(1)
  })

  it('switch on: a pinned row\'s menu offers 取消固定到左侧栏, which unpins its pinned session; other rows do not offer it', async () => {
    publishSidebarChatView({ focusedChatId: null, groups: [], oneList: true })
    publishSidebarPinnedAgents(pins)
    await render()
    expect(await unpinItem('dm-solo')).toBeNull()
    expect(await unpinItem('dm-human')).toBeNull()
    await clickElement((await unpinItem('dm-room-agent'))!)
    expect(unpinFromSidebar).toHaveBeenCalledWith('s-room')
  })

  it('after unpinning (the task page publishes the list without it) the agent has no row of its own again', async () => {
    publishSidebarChatView({ focusedChatId: null, groups: [], oneList: true })
    publishSidebarPinnedAgents(pins.filter((pin) => pin.agentUserId !== 'a-room'))
    await render()
    expect(rows()).toEqual(['dm-project-agent', 'room', 'project', 'dm-human', 'dm-solo'])
  })

  it('switch off: today\'s list, nothing on top, no home in the preview and no 取消固定到左侧栏', async () => {
    publishSidebarChatView({ focusedChatId: null, groups: [] })
    publishSidebarPinnedAgents(pins)
    await render()
    expect(rows()).toEqual(['dm-room-agent', 'room', 'dm-human'])
    expect(row('dm-room-agent').textContent).not.toContain('Room · ')
    expect(row('dm-room-agent').querySelector('.gg-list-row-meta svg')).toBeNull()
    expect(await unpinItem('dm-room-agent')).toBeNull()
    await clickElement(row('dm-room-agent'))
    expect(openSidebarPin).not.toHaveBeenCalled()
  })
})
