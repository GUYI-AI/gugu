// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clickElement, createReactHarness, renderWithAppProviders } from '../../support/testHarness'
import '../../../apps/desktop/src/i18n/registerAssistantCatalog'
import { AssistantProjectsLibrary, AssistantProjectsCard } from '../../../apps/desktop/src/components/assistant/AssistantProjectsLibrary'
const state = vi.hoisted(() => ({ read: vi.fn(),refresh: vi.fn(),assistantHome: false,published: {} as Record<string, unknown[]>,native: vi.fn(() => { throw new Error('Unexpected device directory read') }) }))
vi.mock('@/platform',() => ({ platform: { capabilities: { agentRuntime: false } } }))
vi.mock('@/session/renderer/lib/stores/app-state',() => ({ appState: {} }))
vi.mock('@/hooks/useSessionpageReveal',() => ({ revealSessionpage: vi.fn() }))
vi.mock('@/lib/deviceProjects',() => ({ listMyDeviceProjects: state.read }))
// Folders come from the devices store (each machine's published device_projects); the page reads nothing of its own.
vi.mock('@/store/devicesContext',() => ({ useDevicesStore: () => ({ devices: [{ device_id: 'mac',label: 'apple 的 MacBook',is_online: false,projects: state.published.mac },{ device_id: 'fc',label: 'FC验收Mac',is_online: false,projects: state.published.fc,capabilities: { assistant_home: state.assistantHome,home_dir: '/home/assistant' } }],loading: false,error: null,refresh: state.refresh }) }))
vi.mock('@/session/shared/remote-sessions/session-directory',() => ({ useLiveDeviceSessions: state.native,deviceSessionsOf: state.native }))
import { runInAction } from 'mobx'
import { accountProjectsStore } from '../../../apps/desktop/src/session/renderer/features/projects/stores/account-projects-store'
let harness: ReturnType<typeof createReactHarness>
type Records = Record<string, Array<{ localProjectId: string; name: string }>>
/** The project list is the account project list (accountProjectsStore): here one account project per published record. */
const seed = (records: Records) => runInAction(() => {
  accountProjectsStore.list = Object.entries(records).flatMap(([deviceId, list]) => list.map(record => ({
    chatId: `${deviceId}/${record.localProjectId}`, name: record.name, archived: false, bindings: [{ deviceId, localProjectId: record.localProjectId }],
  })))
  accountProjectsStore.status = 'ready'
})
const records = (value: Records) => { seed(value); state.published = value; return value }
const project = (id: string,name: string) => ({ localProjectId: id,name,rootPath: '/fixture',createdAt: '2026-10-26',chatId: null,folders: [] })
beforeEach(() => { harness = createReactHarness(); state.assistantHome = false; state.native.mockClear(); state.read.mockReset(); records({ mac: [project('mac-business','Mac project'),project('gugu','咕咕')],fc: [project('fc-business','FC project')] }) })
afterEach(() => { expect(state.read, 'the page reads no device_projects of its own').not.toHaveBeenCalled() })
afterEach(() => { harness.cleanup(); accountProjectsStore.clear() })
it('lists every account project while both devices are asleep and opens an empty project entry', async () => {
  await renderWithAppProviders(harness,<AssistantProjectsLibrary machine={null} />)
  await vi.waitFor(() => expect(harness.container.textContent).toContain('FC project'))
  const rows = [...harness.container.querySelectorAll<HTMLElement>('[data-testid^="assistant-project-"]')]
  expect(rows).toHaveLength(3)
  expect(harness.container.textContent).toContain('Mac project')
  expect(harness.container.textContent).toContain('咕咕')
  expect(harness.container.textContent).not.toContain('与咕咕项目页使用同一份项目')
  await clickElement(rows[0]!)
  expect(harness.container.querySelector('[data-testid="assistant-project-cloud-index"]')).not.toBeNull()
  expect(state.native).not.toHaveBeenCalled()
})
it('counts the same three entries on the memory page', async () => {
  await renderWithAppProviders(harness,<AssistantProjectsCard machine={null} />)
  await vi.waitFor(() => expect(harness.container.textContent).toContain('3 条记录'))
  expect(state.native).not.toHaveBeenCalled()
})
// #1629: the assistant host is not one of the person's projects (device-level rule, same as the desktop sidebar).
// Ordinary-device projects stay separate and are named after their projects, never after the device.
it('hides projects on the assistant host and names ordinary-device projects after their projects', async () => {
  state.assistantHome = true
  records({ fc: [project('first', 'First business'),project('second', 'Second business')],mac: [project('third', 'Third business'),project('fourth', 'Fourth business')] })
  await renderWithAppProviders(harness, <AssistantProjectsLibrary machine={null} />)
  await vi.waitFor(() => expect(harness.container.querySelectorAll('[data-testid^="assistant-project-"]')).toHaveLength(2))
  expect(harness.container.textContent).toContain('Third business')
  expect(harness.container.textContent).toContain('Fourth business')
  expect(harness.container.textContent).not.toContain('First business')
  expect(harness.container.textContent).not.toContain('Second business')
  expect(harness.container.textContent).not.toContain('FC验收Mac')
  expect(harness.container.textContent).not.toContain('apple 的 MacBook')
  expect(state.native).not.toHaveBeenCalled()
})
it('explains an account project list failure without inventing an empty list or exposing a retry button', async () => {
  runInAction(() => { accountProjectsStore.list = []; accountProjectsStore.status = 'error'; accountProjectsStore.error = 'private SQL diagnostic' })
  await renderWithAppProviders(harness,<AssistantProjectsLibrary machine={null} />)
  await vi.waitFor(() => expect(harness.container.querySelector('[role="alert"]')).not.toBeNull())
  expect(harness.container.textContent).not.toContain('private SQL diagnostic')
  expect(harness.container.textContent).not.toContain('还没有咕咕项目')
  expect([...harness.container.querySelectorAll('button')].some(button => button.textContent === '重试')).toBe(false)
})

it('lists the account projects only: internal task homes published by a machine are not account projects', async () => {
  state.published = {
    mac: [project('00000000-0000-4000-8000-000000000001', 'Trial task home'), project('demo', 'Acceptance demo')],
    old: [project('00000000-0000-4000-8000-000000000001', 'Isolated task home')],
    fc: [project('assistant-home', 'Assistant home')],
  }
  seed({ mac: [project('demo', 'Acceptance demo')], fc: [project('assistant-home', 'Assistant home')] })
  await renderWithAppProviders(harness, <AssistantProjectsLibrary machine={null} />)
  await vi.waitFor(() => expect(harness.container.textContent).toContain('Acceptance demo'))
  expect(harness.container.textContent).toContain('Assistant home')
  expect(harness.container.querySelectorAll('[data-testid^="assistant-project-"]')).toHaveLength(2)
  expect(harness.container.textContent).not.toContain('Trial task home')
  expect(harness.container.textContent).not.toContain('Isolated task home')
  expect(state.native).not.toHaveBeenCalled()
})
