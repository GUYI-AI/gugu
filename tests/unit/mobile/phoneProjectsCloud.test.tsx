// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clickElement, createReactHarness, renderWithAppProviders } from '../../support/testHarness'
import '../../../apps/desktop/src/i18n/registerAssistantCatalog'
import { AssistantProjectsLibrary, AssistantProjectsCard } from '../../../apps/desktop/src/components/assistant/AssistantProjectsLibrary'
const state = vi.hoisted(() => ({ native: vi.fn(() => { throw new Error('Unexpected device directory read') }) }))
vi.mock('@/platform',() => ({ platform: { capabilities: { agentRuntime: false } } }))
vi.mock('@/session/renderer/lib/stores/app-state',() => ({ appState: {} }))
vi.mock('@/hooks/useSessionpageReveal',() => ({ revealSessionpage: vi.fn() }))
vi.mock('@/session/shared/remote-sessions/session-directory',async (original) => ({ ...await original<object>(),useLiveDeviceSessions: state.native,deviceSessionsOf: state.native }))
import { runInAction } from 'mobx'
import { groupFoldersStore } from '../../../apps/desktop/src/session/renderer/features/folders/group-folders-store'
let harness: ReturnType<typeof createReactHarness>
/** The list is the account's groups with folders (groupFoldersStore): here one group per folder, machines all asleep. */
const seed = (records: Record<string, Array<{ id: string; name: string }>>) => runInAction(() => {
  groupFoldersStore.account = Object.entries(records).flatMap(([deviceId, list]) => list.map(record => ({
    chatId: `${deviceId}/${record.id}`, name: record.name, archived: false, activeAt: '2026-01-01T00:00:00.000Z',
    folders: [{ deviceId, folderId: record.id, path: `/fixture/${record.id}`, position: 1, attachedAt: null, removalRequestedAt: null }],
  })))
  groupFoldersStore.status = 'ready'
})
beforeEach(() => { harness = createReactHarness(); state.native.mockClear(); seed({ mac: [{ id: 'mac-business', name: 'Mac project' }, { id: 'gugu', name: '咕咕' }], fc: [{ id: 'fc-business', name: 'FC project' }] }) })
afterEach(() => { harness.cleanup(); groupFoldersStore.clear() })
it('lists every group with folders while both devices are asleep and opens its folder index', async () => {
  await renderWithAppProviders(harness,<AssistantProjectsLibrary machine={null} />)
  await vi.waitFor(() => expect(harness.container.textContent).toContain('FC project'))
  const rows = [...harness.container.querySelectorAll<HTMLElement>('[data-testid^="assistant-project-"]')]
  expect(rows).toHaveLength(3)
  expect(harness.container.textContent).toContain('Mac project')
  expect(harness.container.textContent).toContain('咕咕')
  await clickElement(rows[0]!)
  expect(harness.container.querySelector('[data-testid="assistant-project-cloud-index"]')).not.toBeNull()
  expect(state.native).not.toHaveBeenCalled()
})
it('counts the same three entries on the memory page', async () => {
  await renderWithAppProviders(harness,<AssistantProjectsCard machine={null} />)
  await vi.waitFor(() => expect(harness.container.textContent).toContain('3 条记录'))
  expect(state.native).not.toHaveBeenCalled()
})
it('explains a group folder list failure without inventing an empty list or exposing a retry button', async () => {
  runInAction(() => { groupFoldersStore.account = []; groupFoldersStore.status = 'error'; groupFoldersStore.error = 'private SQL diagnostic' })
  await renderWithAppProviders(harness,<AssistantProjectsLibrary machine={null} />)
  await vi.waitFor(() => expect(harness.container.querySelector('[role="alert"]')).not.toBeNull())
  expect(harness.container.textContent).not.toContain('private SQL diagnostic')
  expect(harness.container.textContent).not.toContain('还没有咕咕项目')
  expect([...harness.container.querySelectorAll('button')].some(button => button.textContent === '重试')).toBe(false)
})
