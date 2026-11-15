// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { until } from '../../../support/awaitCondition'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import type { ContactUser } from '@gugu/core/shared/types/contacts'

// The phone's task page: a file of the agent's own chat (its task folder), followed from a link in the task.
const state = vi.hoisted(() => ({ resolve: vi.fn(), notify: vi.fn(), shown: vi.fn() }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { kind: 'capacitor', capabilities: {} } }))
vi.mock('../../../../apps/desktop/src/platform/desktopIpc', () => ({ desktopIpc: () => null }))
vi.mock('../../../../apps/desktop/src/lib/notices', () => ({ notify: state.notify }))
vi.mock('../../../../apps/desktop/src/lib/fileAccess', () => ({ localFileRevision: async () => null }))
vi.mock('../../../../apps/desktop/src/components/appSlot/appsHere', () => ({ appsHere: { groupFileOpener: state.resolve } }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: {
  rpc: async () => ({ error: null }),
  from: () => {
    const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: { chat_id: 'dm' }, error: null }) }
    return query
  },
} }))
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({
  appendToDraft: (old: string, text: string) => [old, text].filter(Boolean).join('\n'),
  useChatStoreReader: () => () => ({ drafts: {}, draftAttachments: {}, writeDraft: vi.fn(), setDraftAttachments: vi.fn(), identitiesById: {}, setActiveChatId: vi.fn() }),
}))
vi.mock('../../../../apps/desktop/src/session/shared/remote-sessions/session-directory', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../apps/desktop/src/session/shared/remote-sessions/session-directory')>(),
  directoryDevices: () => [{ device_id: 'host', is_online: true, capabilities: {}, projects: [], session_digest: [{ conversationId: 'session', projectId: 'project', title: 'Task', harness: 'claude', supported: true, agentUserId: 'agent', nativeInputVersion: 1, runtime: 'acp' }] }],
}))
vi.mock('../../../../apps/desktop/src/components/appSlot/phoneAppHost', async () => {
  const { openLinkWith } = await import('../../../../apps/desktop/src/session/shared/extensions/open-link')
  const { openLinkTarget } = await import('../../../../apps/desktop/src/lib/guguLinks')
  return { openPhoneLink: (target: never) => openLinkWith({ openResource: openLinkTarget } as never, target) }
})
vi.mock('../../../../apps/desktop/src/components/appSlot/GroupTabContent', () => ({
  GroupTabContent: ({ item }: { item: { itemId?: string } }) => <div data-testid="phone-file-page">{item.itemId}</div>,
}))
import { useLinkNavigation } from '../../../../apps/desktop/src/hooks/useLinkNavigation'
import { useOwnedAgentConversationEntry } from '../../../../apps/desktop/src/hooks/useOwnedAgentConversationEntry'
import { followLink } from '../../../../apps/desktop/src/lib/guguLinks'
import { openOwnedAgentResource } from '../../../../apps/desktop/src/lib/ownedAgentConversation'
import { clearOwnedAgentResources } from '../../../../apps/desktop/src/lib/ownedAgentResources'
import { OwnedAgentResourcesHost } from '../../../../apps/desktop/src/components/appSlot/OwnedAgentResourcesHost'
import { askChatFile, closeChatTab, panelTabsOf } from '../../../../apps/desktop/src/session/renderer/features/chats/chat-tabs/chat-layouts'
import { APP_SHOW_SESSION_EVENT } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'

const FILE = '9d3f8bca-be6e-4b34-8388-4ab2b0fdf3e1'
const chats = [{ id: 'dm', kind: 'dm', peer_user_id: 'agent' }] as ChatItem[]
const contacts = [{ id: 'agent', type: 'agent', owner_user_id: 'owner' }] as ContactUser[]
const detail = { chatId: 'dm', itemId: FILE, name: 'q.csv', typedName: 'q.csv', choice: { kind: 'one', candidate: { tabKind: 'workspace.file', suffix: '.csv' } } }
let harness: ReturnType<typeof createReactHarness>

// The shell's file opening as MainLayout wires it: the agent's own chat opens beside its task, on the phone as on a computer.
function PhoneShell() {
  useOwnedAgentConversationEntry({ ownerId: 'owner', chats: () => chats, contacts: () => contacts, mobile: true, onOpen() {} })
  useLinkNavigation({ ownerId: 'owner', chats: () => chats, contacts: () => contacts,
    openChat() {}, openAssistant() {}, openApp() {}, openOwnApp() {}, openProject() {},
    openFile: async (chatId, target, source, opener) => {
      if (!await openOwnedAgentResource(chatId)) throw new Error('not the agent of this person')
      await askChatFile(chatId, { itemId: target.itemId, opener, ...source })
    },
  })
  return <OwnedAgentResourcesHost ownerId="owner" mobile />
}
const page = () => harness.container.ownerDocument.querySelector('[data-testid="phone-file-page"]')

beforeEach(() => {
  harness = createReactHarness()
  state.resolve.mockReset(); state.notify.mockReset(); state.shown.mockReset()
  state.resolve.mockResolvedValue({ success: true, data: detail })
  window.addEventListener(APP_SHOW_SESSION_EVENT, state.shown)
})
afterEach(() => {
  window.removeEventListener(APP_SHOW_SESSION_EVENT, state.shown)
  for (const tab of panelTabsOf('dm')) closeChatTab('dm', tab.tabId)
  harness.cleanup(); clearOwnedAgentResources('owner')
})

it('opens a task-folder file over the phone task page the way the computer does', async () => {
  await harness.render(<PhoneShell />)
  await act(async () => { followLink(`gugu-file://${FILE}?v=1`) })
  await act(async () => { await until('the file page is shown', () => page() !== null) })
  expect(page()?.textContent).toBe(FILE)
  expect(state.shown).toHaveBeenCalledOnce()
  expect(state.notify).not.toHaveBeenCalled()
}, 20_000)

it('opens the file once for two quick taps and tells nobody the first was replaced', async () => {
  let finishFirst!: (value: unknown) => void
  state.resolve.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve }))
  await harness.render(<PhoneShell />)
  await act(async () => { followLink(`gugu-file://${FILE}?v=1`) })
  await act(async () => { await until('first file resolution started', () => state.resolve.mock.calls.length === 1) })
  // The second tap joins the open under way: the host is not asked again, and the one answer opens the file once.
  await act(async () => { followLink(`gugu-file://${FILE}?v=1`) })
  expect(page()).toBeNull()
  await act(async () => { finishFirst({ success: true, data: detail }) })
  await act(async () => { await until('the file page is shown', () => page() !== null) })
  expect(state.resolve).toHaveBeenCalledOnce()
  expect(panelTabsOf('dm')).toHaveLength(1)
  expect(state.notify).not.toHaveBeenCalled()
}, 20_000)
