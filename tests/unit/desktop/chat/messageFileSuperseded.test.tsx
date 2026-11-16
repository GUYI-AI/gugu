// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { createReactHarness } from '../../../support/testHarness'
import { until } from '../../../support/awaitCondition'
import { useMessageFilePreview } from '../../../../apps/desktop/src/components/chat/useMessageFilePreview'
import { useChatOpener } from '../../../../apps/desktop/src/components/appSlot/useChatOpener'
import { useLinkNavigation } from '../../../../apps/desktop/src/hooks/useLinkNavigation'
import { appsHere } from '../../../../apps/desktop/src/components/appSlot/appsHere'
import { askChatFile, closeChatTab, panelTabsOf } from '../../../../apps/desktop/src/session/renderer/features/chats/chat-tabs/chat-layouts'

// A file card clicked, then another before the first is up: the first was replaced, nothing failed — no notice for it.
// A real failure still says so.
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { kind: 'electron', capabilities: {} } }))
vi.mock('../../../../apps/desktop/src/lib/fileAccess', () => ({ localFileRevision: async () => null }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: { rpc: async () => ({ error: null }) } }))
vi.mock('../../../../apps/desktop/src/components/appSlot/appsHere', () => ({ appsHere: { groupFileOpener: vi.fn() } }))

const group = 'card-superseded'
const toast = vi.fn()
let harness: ReturnType<typeof createReactHarness>
const answer = (itemId: string) => ({ chatId: group, itemId, name: `${itemId}.md`, typedName: `${itemId}.md`, choice: { kind: 'one', candidate: { tabKind: 'workspace.file', suffix: '.md' } } })
function Entry() {
  useLinkNavigation({ ownerId: 'owner', chats: () => [{ id: group, kind: 'group' }] as never, contacts: () => [],
    openChat() {}, openFile: (chatId, target, source, opener) => askChatFile(chatId, { itemId: target.itemId, opener, ...source }),
    openApp() {}, openOwnApp() {}, openProject() {}, openAssistant() {},
  })
  const opener = useChatOpener(group)
  const preview = useMessageFilePreview({ mobile: false, visible: true, closeRightSurfaces() {}, toast })
  const card = (itemId: string) => createElement('button', { 'data-card': itemId, onClick: () => preview.open({ kind: 'file', fileName: `${itemId}.md`, mimeType: 'text/markdown', sizeBytes: 1, source: { kind: 'item', itemId, version: 1 } }, { id: `message-${itemId}`, chat_id: group } as MessageItem) })
  return createElement('div', null, opener.overlay, card('A'), card('B'))
}
const click = (itemId: string) => act(async () => harness.container.querySelector<HTMLButtonElement>(`[data-card="${itemId}"]`)!.click())
const settled = () => new Promise<void>((done) => setTimeout(done, 0))
beforeEach(() => { harness = createReactHarness(); toast.mockReset(); vi.mocked(appsHere!.groupFileOpener).mockReset() })
afterEach(() => { for (const tab of panelTabsOf(group)) closeChatTab(group, tab.tabId); harness.cleanup() })

it('A, then B before A is up: B opens, and A being replaced says nothing', async () => {
  const held = new Map<string, () => void>()
  vi.mocked(appsHere!.groupFileOpener).mockImplementation(({ itemId }) => new Promise((resolve) => held.set(itemId, () => resolve({ success: true, data: answer(itemId) } as never))))
  await harness.render(createElement(Entry))
  await click('A')
  await until('A is asked of the host', () => held.has('A'))
  await click('B')
  await until('B is asked of the host', () => held.has('B'))
  await act(async () => { held.get('B')!(); await settled() })
  await act(async () => { held.get('A')!(); await settled() })
  await until('B is open', () => panelTabsOf(group).length === 1)
  expect(panelTabsOf(group).map((tab) => tab.item.itemId)).toEqual(['B'])
  expect(toast).not.toHaveBeenCalled()
})

it('a file the host refuses still says so', async () => {
  vi.mocked(appsHere!.groupFileOpener).mockResolvedValue({ success: false, error: 'No such file in this chat' })
  await harness.render(createElement(Entry))
  await click('A')
  await until('the refusal is said', () => toast.mock.calls.length > 0)
  expect(toast).toHaveBeenCalledOnce()
  expect(toast.mock.calls[0]![1]).toBe('error')
  expect(panelTabsOf(group)).toHaveLength(0)
})
