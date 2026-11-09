// @vitest-environment jsdom
// A relative link in a group message, tapped on a phone: the shown message, the link navigation and the agent's task entry,
// as the phone shell has them together. The tap opens the sender's task and carries no file: the phone cannot read that yet.
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { MessageList, type ChatListRowItem, type MessageListRowProps } from '../../../../apps/desktop/src/components/chat/MessageList'
import { useLinkNavigation } from '../../../../apps/desktop/src/hooks/useLinkNavigation'
import { useOwnedAgentConversationEntry } from '../../../../apps/desktop/src/hooks/useOwnedAgentConversationEntry'
import { APP_SHOW_SESSION_EVENT } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'
import { createReactHarness, message, renderWithAppProviders } from '../../../support/testHarness'

const scope = vi.hoisted(() => ({ notify: vi.fn(), devices: [] as unknown[] }))
vi.mock('../../../../apps/desktop/src/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }))
vi.mock('../../../../apps/desktop/src/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: scope.devices, phones: [] }) }))
vi.mock('../../../../apps/desktop/src/session/shared/remote-sessions/session-directory', async (importOriginal) => ({ ...await importOriginal<object>(), directoryDevices: () => scope.devices }))
vi.mock('../../../../apps/desktop/src/platform/desktopIpc', () => ({ desktopIpc: () => null }))
vi.mock('../../../../apps/desktop/src/hooks/useMobileShell', () => ({ readMobileShell: () => true, useMobileShell: () => true }))
vi.mock('../../../../apps/desktop/src/lib/notices', () => ({ notify: scope.notify }))

const noop = () => {}
const mine = { id: 'agent', type: 'agent', owner_user_id: 'user-1', display_name: 'Agent' } as ContactUser
const theirs = { id: 'their-agent', type: 'agent', owner_user_id: 'someone', display_name: 'Theirs' } as ContactUser

function Shell() {
  useOwnedAgentConversationEntry({ ownerId: 'user-1', chats: () => [], contacts: () => [mine, theirs], mobile: true, onOpen: noop })
  useLinkNavigation({ ownerId: 'user-1', chats: () => [], contacts: () => [mine, theirs], openSender: noop, openChat: vi.fn(), openFile: vi.fn(), openApp: vi.fn(), openProject: vi.fn(), openOwnApp: vi.fn(), openAssistant: vi.fn() } as never)
  return null
}

let harness: ReturnType<typeof createReactHarness>
const shown = vi.fn()
beforeEach(() => {
  harness = createReactHarness()
  vi.clearAllMocks()
  scope.devices = [{ device_id: 'host', is_online: false, capabilities: {}, projects: [], session_digest: [{ conversationId: 'session', projectId: 'project', title: 'Task', harness: 'claude', supported: true, agentUserId: 'agent', nativeInputVersion: 1, runtime: 'acp' }] }]
  window.addEventListener(APP_SHOW_SESSION_EVENT, shown)
})
afterEach(() => {
  window.removeEventListener(APP_SHOW_SESSION_EVENT, shown)
  harness.cleanup()
})

async function tapLinkFrom(sender: string) {
  const messages = [message({ id: 'm-1', seq: 1, sender_user_id: sender, content: 'see [add.ts](src/add.ts)' })]
  const rows: ChatListRowItem[] = messages.map((msg) => ({ type: 'message', message: msg }))
  const rowProps = {
    rows, messages, mobile: true, memberReadSeqs: {}, deliveryWaits: new Map(), isGroupChat: true, memberProfiles: {},
    onReaction: noop, onQuote: noop, onForward: noop, onDelete: noop, onVisible: noop, selectMode: false, selectedIds: new Set(), onToggleSelect: noop, onEnterSelectMode: noop,
  } as unknown as MessageListRowProps
  await renderWithAppProviders(harness, <><Shell />{createElement(MessageList, { rows, rowProps, resetKey: 'group-1' })}</>)
  const link = harness.container.querySelector<HTMLAnchorElement>('a[href="src/add.ts"]')
  if (!link) throw new Error('the message did not draw its link')
  await act(async () => { link.click() })
}

it("a tap on an agent's relative link opens that agent's task on its machine, without the file", async () => {
  await tapLinkFrom('agent')
  await vi.waitFor(() => expect(shown.mock.calls.length + scope.notify.mock.calls.length).toBe(1))
  expect(scope.notify).not.toHaveBeenCalled()
  const { detail } = shown.mock.calls[0]![0] as CustomEvent
  expect(detail).toMatchObject({ deviceId: 'host', session: { conversationId: 'session' } })
  expect(detail).not.toHaveProperty('file')
})

it('a tap on a path from someone else says it cannot be opened here', async () => {
  await tapLinkFrom('their-agent')
  await vi.waitFor(() => expect(scope.notify).toHaveBeenCalledOnce())
  expect(scope.notify.mock.calls[0]![0]).toMatchObject({ tier: 'error', title: expect.stringMatching(/sender|发送者/) })
  expect(shown).not.toHaveBeenCalled()
})
