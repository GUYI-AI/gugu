// @vitest-environment jsdom
// GUYI-AI/gugu#2548 ⌃X⌃X on the task page archives the open task and moves on to the next item of the list the user sees,
// as the old sidebar did. That list is the one list, the sidebar's chat list: the row after the lit one, opened as ⌘↓
// opens it; the one before it at the end; nothing when there is no other row or no lit row.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatListPanel } from '../../../../apps/desktop/src/components/ChatListPanel'
import { openOneListNeighbour, publishSidebarChatView } from '../../../../apps/desktop/src/lib/sidebarChatsBridge'
import { installOwnedAgentEntry } from '../../../../apps/desktop/src/lib/ownedAgentConversation'
import { publishDirectoryDevices, removeDeviceSessions, updateDeviceSessions } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
import { installSessionViewRequestBridge } from '../../../../apps/desktop/src/session/renderer/features/sessions/stores/session-view-requests'
import { chat, createNode, createReactHarness, device, displayIdentity, renderWithAppProviders } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/platform', () => import('../../../support/capacitorPlatformTestDouble'))
vi.mock('../../../../apps/desktop/src/hooks/useAgentDisplayStatus', async () => ({
  ...await import('../../../support/agentDisplayStatusTestDouble'),
  useAgentDisplayStatuses: () => ({}),
}))

// jsdom has no layout: give the sidebar list's scroller a window's height so its virtualized lines mount (@@@sidebar-chat-window).
beforeEach(() => {
  for (const [key, value] of [['offsetHeight', 900], ['offsetWidth', 1024]] as const) Object.defineProperty(document.documentElement, key, { configurable: true, get: () => value })
})

const openChat = vi.fn()
const openAgent = vi.fn(() => true)
let harness: ReturnType<typeof createReactHarness>
let release: () => void
beforeEach(() => {
  harness = createReactHarness()
  openChat.mockReset()
  openAgent.mockClear()
  installSessionViewRequestBridge(window, { openChat })
  release = installOwnedAgentEntry({ owns: (id) => id === 'a-solo', open: openAgent })
  publishDirectoryDevices([device('mac', [])])
  updateDeviceSessions('mac', {
    projects: [{ id: 'tasks', name: '', path: '/tasks', kind: 'workspace' }],
    sessions: [{ conversationId: 's-solo', projectId: 'tasks', title: 'Solo', harness: 'codex', runtime: 'acp', agentStatus: 'idle', lastInteractedAt: null, supported: true, agent: { userId: 'a-solo' } }],
    cached: false, loading: false,
  })
})
afterEach(() => {
  harness.cleanup()
  release()
  publishSidebarChatView({ focusedChatId: null, groups: [] })
  publishDirectoryDevices([])
  removeDeviceSessions('mac')
})

const at = (day: number) => `2099-01-0${day}T00:00:00Z`
const chats = [
  chat({ id: 'room', kind: 'group', name: 'Room', member_user_ids: ['me'], last_message_at: at(5) }),
  chat({ id: 'dm-solo', peer_user_id: 'a-solo', last_message_at: at(4) }),
  chat({ id: 'dm-human', peer_user_id: 'human', last_message_at: at(3) }),
]
const identitiesById = { me: displayIdentity('me'), human: displayIdentity('human'), 'a-solo': displayIdentity('a-solo', { type: 'agent', owner_user_id: 'me' }) }
const render = async (focusedChatId: string | null) => {
  publishSidebarChatView({ focusedChatId, groups: [], oneList: true })
  await renderWithAppProviders(harness, createNode(ChatListPanel, { placement: 'sidebar' }), { auth: { id: 'me' }, chat: { chats, identitiesById }, contacts: {} })
  expect([...harness.container.querySelectorAll<HTMLElement>('[data-chat-row]')].map((row) => row.dataset.chatRow)).toEqual(['room', 'dm-solo', 'dm-human'])
}

describe('the one list\'s row next to the lit one', () => {
  it('is the row after it, opened as ⌘↓ opens it: a standalone agent\'s row opens its task', async () => {
    await render('room')
    expect(openOneListNeighbour()).toBe(true)
    expect(openAgent).toHaveBeenCalledWith('dm-solo', 'a-solo', undefined, undefined, undefined)
    expect(openChat).not.toHaveBeenCalled()
  })

  it('is the row before it when the lit row is the last one', async () => {
    await render('dm-human')
    expect(openOneListNeighbour()).toBe(true)
    expect(openAgent).toHaveBeenCalledTimes(1)
  })

  it('is none without a lit row (the open task has no row in the list), and none once the list is gone', async () => {
    await render(null)
    expect(openOneListNeighbour()).toBe(false)
    harness.cleanup()
    expect(openOneListNeighbour()).toBe(false)
    expect(openAgent).not.toHaveBeenCalled()
    expect(openChat).not.toHaveBeenCalled()
  })
})
