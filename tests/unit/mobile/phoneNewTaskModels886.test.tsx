// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionpageSessionCreateModels, SessionpageSessionCreateOptions } from '@gugu/session-core/session-record/contract'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import { DevicesContext, useDevicesStore } from '@/store/devicesContext'
import { PhoneGroupAgentCreation, startPhoneNewTask } from '@/mobile/chat/PhoneNewTask'
import * as rpc from '@/mobile/agent-watch/sessionpage-rpc'
import { clickElement, createReactHarness, deferred, device, renderWithAppProviders } from '../../support/testHarness'
import { readComposer, writeComposer } from '../../support/composerEditor'
import { runInAction } from 'mobx'
import { composerDrafts } from '@renderer/features/sessions/composer-drafts'
import { mobileCreationDraftKey } from '@/mobile/agent-watch/create-session-draft'
import { accountProjectsStore } from '@/session/renderer/features/projects/stores/account-projects-store'

// The task folder card's project is the account project of this group (accountProjectsStore); 'machine' has its folder.
beforeEach(() => runInAction(() => {
  accountProjectsStore.list = [{ chatId: 'chat', name: 'Project', archived: false, activeAt: '2026-01-01T00:00:00.000Z', bindings: [{ deviceId: 'machine', localProjectId: 'project' }] }]
  accountProjectsStore.status = 'ready'
}))
afterEach(() => accountProjectsStore.clear())

let harness: ReturnType<typeof createReactHarness>
const width = Object.getOwnPropertyDescriptor(window, 'innerWidth')!
const options: SessionpageSessionCreateOptions = {
  projects: [{ id: 'project', name: 'Project', path: '/project' }], lastUsed: null,
  harnesses: ['claude', 'codex'].map((id) => ({ id, name: id === 'codex' ? 'Codex' : 'Claude', status: 'available', watchable: true, sessionViews: ['general'], permissionModes: ['full-access'] })),
}
const catalogue = (harness = 'codex', signedIn = false): SessionpageSessionCreateModels => ({
  harness, transport: 'acp', selected: 'own-model', selectedEffort: null, efforts: [],
  harnessState: 'ready', harnessReason: null, guguReason: null,
  harnessAuth: signedIn ? 'signed-in' : 'signed-out', selectedCredential: signedIn ? 'credentialed' : 'uncredentialed',
  models: [{ id: 'own-model', name: 'Own model', source: 'harness' }, { id: 'platform:available-model', name: 'Available model', source: 'gugu' }],
})
const sheet = () => document.querySelector<HTMLElement>('[data-testid="phone-group-agent-sheet"]')
const input = () => sheet()?.querySelector<HTMLElement>('[contenteditable="true"]')!
const click = async (testId: string) => clickElement(document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!)
const openFolder = () => click('agent-watch-create-folder')
const closeFolder = () => click('phone-task-folder-card-close')
const send = async () => { await clickElement(sheet()?.querySelector<HTMLButtonElement>('[data-slot="composer-bar"] button[aria-label="发送消息"]')!) }
beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
  harness = createReactHarness()
  vi.spyOn(rpc, 'fetchCreateOptions').mockResolvedValue(options)
  vi.spyOn(rpc, 'fetchCreateModels').mockImplementation(async (_device, harness) => catalogue(harness))
  vi.spyOn(rpc, 'createSession').mockResolvedValue({ conversationId: 'session', projectId: 'project', title: 'Task', taskMessageId: 'task-card' })
})
afterEach(() => { harness.cleanup(); Object.defineProperty(window, 'innerWidth', width); vi.restoreAllMocks() })
async function mount(chooseFolder = true, projectGroup = true) {
  function Host() {
    const base = useDevicesStore()
    return <DevicesContext.Provider value={{ ...base, devices: [device('machine', [], { projects: [{
      localProjectId: 'project', name: 'Project', rootPath: '/project', createdAt: '2026-10-26T00:00:00Z', chatId: 'chat',
      folders: [{ workspaceId: 'workspace', kind: 'root', path: '/project', attachedAt: null }],
    }] })] }}><ChatMessageComposer chatId="chat" isGroupChat onSend={vi.fn()} /><PhoneGroupAgentCreation chatId="chat" name="Project group" /></DevicesContext.Provider>
  }
  if (!projectGroup) accountProjectsStore.clear()
  await import('@/mobile/agent-watch/CreateSessionPage')
  composerDrafts.set(mobileCreationDraftKey('me', 'chat'), '')
  await renderWithAppProviders(harness, <Host />, { auth: { id: 'me' } })
  await act(async () => { startPhoneNewTask('chat') })
  if (chooseFolder) {
    if (projectGroup) { await openFolder(); await click('project-folder-paper') }
    await act(async () => { writeComposer(input(), 'Keep this task draft') })
  }
}

it('shows the destination and opens the project folder picker from the Project control', async () => {
  await mount(false)
  expect(sheet()?.textContent).toContain('Project group')
  expect(document.querySelector('[data-testid="phone-task-folder-card"]')).toBeNull()
  await openFolder()
  expect(document.querySelector('[data-testid="phone-task-folder-card"]')).not.toBeNull()
  await closeFolder()
  expect(document.querySelector('[data-testid="phone-task-folder-card"]')).toBeNull()
  expect(sheet()).not.toBeNull()
})

it('keeps the selected folder and its draft when its picker is dismissed', async () => {
  await mount()
  await openFolder()
  await closeFolder()
  expect(readComposer(input())).toBe('Keep this task draft')
  await send()
  expect(rpc.createSession).toHaveBeenCalledWith('machine', expect.objectContaining({ cwd: '/project' }))
})

async function pickCodex() {
  await clickElement(sheet()?.querySelector<HTMLElement>('[data-testid="agent-watch-create-model-device"]')!)
  await clickElement(document.querySelector<HTMLElement>('[data-testid="agent-watch-create-options-drill"][data-dimension="harness"]')!)
  await clickElement([...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((item) => item.textContent === 'Codex')!)
  await clickElement(document.querySelector<HTMLElement>('[data-testid="agent-watch-create-controls-sheet-close"]')!)
}

it('dispatches the original group new-task route with the shared available model after switching Claude to unsigned-in Codex', async () => {
  await mount()
  await pickCodex()
  await send()
  expect(rpc.fetchCreateModels).toHaveBeenCalledWith('machine', 'codex', null, null)
  expect(rpc.createSession).toHaveBeenCalledExactlyOnceWith('machine', expect.objectContaining({ harness: 'codex', model: 'platform:available-model', chatId: 'chat', cwd: '/project' }))
  expect(sheet()).toBeNull()
})

it('keeps a quick-send draft until that harness catalogue arrives', async () => {
  const pending = deferred<SessionpageSessionCreateModels>()
  vi.mocked(rpc.fetchCreateModels).mockReturnValue(pending.promise)
  await mount()
  await pickCodex()
  await send()
  expect(rpc.createSession).not.toHaveBeenCalled()
  expect(readComposer(input())).toBe('Keep this task draft')
  expect(sheet()?.textContent).toContain('模型')
  await act(async () => { pending.resolve(catalogue()); await pending.promise })
  await send()
  expect(rpc.createSession).toHaveBeenCalledWith('machine', expect.objectContaining({ harness: 'codex', model: 'platform:available-model' }))
})

it('keeps the draft and shows the shared sign-in explanation when no platform model is available', async () => {
  vi.mocked(rpc.fetchCreateModels).mockImplementation(async (_device, harness) => ({ ...catalogue(harness), models: catalogue(harness).models.filter((model) => model.source === 'harness') }))
  await mount()
  await pickCodex()
  await send()
  expect(rpc.createSession).not.toHaveBeenCalled()
  expect(readComposer(input())).toBe('Keep this task draft')
  expect(sheet()?.textContent).toContain('还没登录')
})

it('uses the same remembered signed-in own default as CreateSessionPage', async () => {
  vi.mocked(rpc.fetchCreateOptions).mockResolvedValue({ ...options, lastUsed: { projectId: 'project', harness: 'codex', model: null, effort: null, permissionMode: null, sessionView: 'general' } })
  vi.mocked(rpc.fetchCreateModels).mockImplementation(async (_device, harness) => catalogue(harness, true))
  await mount()
  await send()
  expect(rpc.createSession).toHaveBeenCalledExactlyOnceWith('machine', expect.objectContaining({ harness: 'codex' }))
  expect(vi.mocked(rpc.createSession).mock.calls[0]?.[1]).not.toHaveProperty('model')
})

it('replaces a remembered own model that is no longer signed in with the shared available default', async () => {
  vi.mocked(rpc.fetchCreateOptions).mockResolvedValue({ ...options, lastUsed: { projectId: 'project', harness: 'codex', model: 'own-model', effort: null, permissionMode: null, sessionView: 'general' } })
  await mount()
  await send()
  expect(rpc.createSession).toHaveBeenCalledExactlyOnceWith('machine', expect.objectContaining({ harness: 'codex', model: 'platform:available-model' }))
})

it('does not dispatch an engine default when the catalogue read fails', async () => {
  vi.mocked(rpc.fetchCreateModels).mockRejectedValue(new Error('catalogue unavailable'))
  await mount()
  await send()
  expect(rpc.createSession).not.toHaveBeenCalled()
  expect(readComposer(input())).toBe('Keep this task draft')
  expect(sheet()?.textContent).toContain('读不到这台设备的模型')
})

it('carries an explicitly chosen Work model through the project task send', async () => {
  vi.mocked(rpc.fetchCreateModels).mockImplementation(async (_device, harness) => catalogue(harness, true))
  await mount()
  await pickCodex()
  await clickElement(sheet()?.querySelector<HTMLElement>('[data-testid="agent-watch-create-model-device"]')!)
  await clickElement(document.querySelector<HTMLElement>('[data-testid="agent-watch-create-options-drill"][data-dimension="model"]')!)
  const own = [...document.querySelectorAll<HTMLElement>('button')].find(item => item.textContent?.includes('Own model'))!
  await clickElement(own)
  await clickElement(document.querySelector<HTMLElement>('[data-testid="agent-watch-create-controls-sheet-close"]')!)
  await send()
  expect(rpc.createSession).toHaveBeenCalledWith('machine', expect.objectContaining({ harness: 'codex', model: 'own-model', chatId: 'chat', cwd: '/project' }))
})


it('keeps an ordinary group visible and preserves its creation draft after a failed send', async () => {
  await mount(true, false)
  expect(sheet()?.querySelector('[data-testid="agent-watch-create-project"]')).not.toBeNull()
  expect(document.querySelector('[data-testid="agent-watch-create-page"]')).toBeNull()
  expect(harness.container.querySelector('[data-testid="chat-composer"]')).not.toBeNull()
  vi.mocked(rpc.createSession).mockRejectedValueOnce(new Error('request failed'))
  await send()
  expect(sheet()?.querySelector('[role="alert"]')).not.toBeNull()
  expect(readComposer(input())).toBe('Keep this task draft')
  expect(rpc.createSession).toHaveBeenCalledExactlyOnceWith('machine', expect.objectContaining({
    chatId: 'chat', taskChatId: 'chat', prompt: 'Keep this task draft',
  }))
  await send()
  expect(sheet()).toBeNull()
  expect(harness.container.querySelector('[data-testid="chat-composer"]')).not.toBeNull()
})
