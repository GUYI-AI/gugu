// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runInAction } from 'mobx'
import { AssistantProjectsLibrary } from '../../../../apps/desktop/src/components/assistant/AssistantProjectsLibrary'
import { groupFoldersStore } from '../../../../apps/desktop/src/session/renderer/features/folders/group-folders-store'
import { clickElement, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'
const open = vi.hoisted(() => ({ chat: vi.fn(), reveal: vi.fn() }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/chats/open-chat', () => ({ openChatOnScreen: open.chat }))
vi.mock('../../../../apps/desktop/src/hooks/useSessionpageReveal', () => ({ revealSessionpage: open.reveal }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { capabilities: { agentRuntime: true } } }))
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness(); vi.clearAllMocks()
  runInAction(() => {
    groupFoldersStore.account = [{ chatId: 'travel-chat', name: '天安门旅游', archived: false, activeAt: '2026-11-19T00:00:00.000Z',
      folders: [{ deviceId: 'mac', folderId: 'travel-folder', path: '/projects/travel', position: 0, attachedAt: null, removalRequestedAt: null }] }]
    groupFoldersStore.status = 'ready'
  })
})
afterEach(() => { harness.cleanup(); groupFoldersStore.clear() })
it('lists the group that has a folder and opens that same group, without scanning or creating folders', async () => {
  await renderWithAppProviders(harness, <AssistantProjectsLibrary machine={null} />)
  expect(harness.container.textContent).toContain('天安门旅游')
  expect(harness.container.textContent).toContain('/projects/travel')
  await clickElement(harness.container.querySelector('[data-testid="assistant-project-travel-chat"]')!)
  expect(open.chat).toHaveBeenCalledWith('travel-chat', false)
  expect(open.reveal).toHaveBeenCalledOnce()
})
