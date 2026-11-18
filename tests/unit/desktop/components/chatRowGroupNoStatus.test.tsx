// @vitest-environment jsdom
// A group's avatar carries no status dot: its top-right corner is where the rail puts the unread mark. An agent's own row keeps its dot.
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { ChatListPanel } from '../../../../apps/desktop/src/components/ChatListPanel'
import { publishSidebarChatView } from '../../../../apps/desktop/src/lib/sidebarChatsBridge'
import { chat, createNode, createReactHarness, displayIdentity, renderWithAppProviders } from '../../../support/testHarness'

const followed = vi.hoisted(() => [] as string[][])
vi.mock('../../../../apps/desktop/src/platform', () => import('../../../support/capacitorPlatformTestDouble'))
vi.mock('../../../../apps/desktop/src/hooks/useAgentDisplayStatus', async () => ({
  ...await import('../../../support/agentDisplayStatusTestDouble'),
  // Every agent the list asks about is working: a row that draws a status would show it.
  useAgentDisplayStatuses: (ids: readonly string[]) => { followed.push([...ids]); return Object.fromEntries(ids.map((id) => [id, 'working'])) },
}))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  followed.length = 0
  for (const [key, value] of [['offsetHeight', 900], ['offsetWidth', 1024]] as const) Object.defineProperty(document.documentElement, key, { configurable: true, get: () => value })
})
afterEach(() => { harness.cleanup(); publishSidebarChatView({ focusedChatId: null, groups: [] }) })

const at = (day: number) => `2099-01-0${day}T00:00:00Z`
const chats = [
  chat({ id: 'room', kind: 'group', name: 'Room', member_user_ids: ['me', 'human', 'a-member'], last_message_at: at(3) }),
  chat({ id: 'room-topic', kind: 'topic', name: 'Review', source_chat_id: 'room', member_user_ids: ['me', 'a-member'], last_message_at: at(4) }),
  chat({ id: 'dm-agent', peer_user_id: 'a-peer', last_message_at: at(2) }),
  chat({ id: 'dm-human', peer_user_id: 'human', last_message_at: at(1) }),
]
const identitiesById = {
  me: displayIdentity('me'),
  human: displayIdentity('human'),
  'a-member': displayIdentity('a-member', { type: 'agent', owner_user_id: 'me' }),
  'a-peer': displayIdentity('a-peer', { type: 'agent', owner_user_id: 'me' }),
}
const statusOf = (id: string) => harness.container.querySelector(`[data-chat-row="${id}"] .av-status`)?.className ?? null

it.each([
  ['the desktop list', { placement: 'sidebar' }],
  ['the phone list', { mobile: true }],
])('%s: a group with a working agent draws no status on its avatar; the agent\'s own row does', async (_name, props) => {
  await renderWithAppProviders(harness, createNode(ChatListPanel, props), { chat: { chats, identitiesById }, contacts: {} })
  expect(harness.container.querySelector('[data-chat-row="room"]')).not.toBeNull()
  expect(statusOf('room')).toBeNull()
  expect(statusOf('dm-agent')).toContain('av-status--working')
  expect(statusOf('dm-human')).toBeNull()
  // The list follows only the agents it draws a status for.
  expect(followed.at(-1)).toEqual(['a-peer'])
})
