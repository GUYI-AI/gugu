// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { useAui } from '../../../apps/desktop/node_modules/@assistant-ui/react'
import type { Device } from '@gugu/core/shared/types/chat'
import type { SessionpageSessionCreateOptions, SessionpageSessionCreateResult } from '@gugu/session-core/session-record/contract'
import { CreateSessionPage } from '../../../apps/desktop/src/mobile/agent-watch/CreateSessionPage'
import { composerDrafts } from '../../../apps/desktop/src/session/renderer/features/sessions/composer-drafts'
import { mobileCreationDraftKey } from '../../../apps/desktop/src/mobile/agent-watch/create-session-draft'
import { createNode, createReactHarness, deferred } from '../../support/testHarness'
import { accountProjectsStore } from '../../../apps/desktop/src/session/renderer/features/projects/stores/account-projects-store'
import { runInAction } from 'mobx'

type ComposerClient = ReturnType<typeof useAui>['composer']
const state = vi.hoisted(() => ({ owner: 'creation-navigation', composer: null as ComposerClient | null }))
const rpc = vi.hoisted(() => ({ options: vi.fn(), models: vi.fn(), create: vi.fn() }))
vi.mock('../../../apps/desktop/src/store/auth', async (original) => ({
  ...(await original<typeof import('../../../apps/desktop/src/store/auth')>()),
  useAuth: () => ({ user: { id: state.owner } }),
}))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/useMachineLabel', () => ({
  useMachineLabel: () => ({ label: () => 'Mac', isHome: () => false }),
}))
// 新建页从设备目录里挑机器(DESIGN 4a):每一格把要测的那台放进目录。
const store = vi.hoisted(() => ({ devices: [] as import('@gugu/core/shared/types/chat').Device[] }))
vi.mock('../../../apps/desktop/src/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: store.devices, phones: [] }) }))
vi.mock('../../../apps/desktop/src/hooks/useWakeCloudComputer', () => ({
  useCloudComputerWake: () => ({ issue: null, dropped: false, retry: vi.fn() }),
}))
const rememberRunMachineCloud = vi.hoisted(() => vi.fn(async () => ({})))
vi.mock('../../../apps/desktop/src/lib/agentCreateDefaults', () => ({
  readAgentCreateDefaults: async () => ({ deviceId: null, projectByDevice: {}, projectByChat: {}, machineByProject: {} }),
  rememberAgentCreateRunMachine: rememberRunMachineCloud,
}))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/CreateOptionsPill', () => ({ CreateOptionsPill: () => null }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  SessionpageRpcError: class SessionpageRpcError extends Error { readonly code = 'test' },
  fetchCreateOptions: rpc.options,
  fetchPhoneCreateOptions: rpc.options,
  fetchCreateModels: rpc.models,
  fetchPhoneCreateModels: rpc.models,
  createSession: rpc.create,
  createPhoneSession: rpc.create,
}))
vi.mock('../../../apps/desktop/src/components/assistant-ui/thread.aui', async () => {
  const { useAui } = await import('../../../apps/desktop/node_modules/@assistant-ui/react')
  const { ComposerAboveExtras } = await import('../../../apps/desktop/src/components/assistant-ui/composer-extras')
  return { Thread: () => { state.composer = useAui().composer; return createElement(ComposerAboveExtras) } }
})

const options: SessionpageSessionCreateOptions = {
  projects: [{ id: 'project', name: 'Project', path: '/project' }],
  harnesses: [{ id: 'codex', name: 'Codex', status: 'available', watchable: true, sessionViews: ['general'], permissionModes: ['read-only'] }],
  lastUsed: null,
}
const device: Device = {
  device_id: 'creation-device', label: 'Mac', hostname: 'mac', platform: 'darwin', status: 'online',
  is_online: true, last_seen_at: '2026-10-21T00:00:00.000Z', capabilities: { terminals: [], runtimes: ['codex'] },
}
const result: SessionpageSessionCreateResult = { conversationId: 'created-task', projectId: 'project', title: 'Created task' }
let harness: ReturnType<typeof createReactHarness>
const pageOn = (on: Device, props: Omit<Parameters<typeof CreateSessionPage>[0], 'onBack'> & { onBack?: () => void }) => {
  store.devices = [on]
  return createNode(CreateSessionPage, props)
}
beforeEach(() => {
  harness = createReactHarness()
  state.composer = null
  state.owner = 'creation-navigation'
  composerDrafts.set(mobileCreationDraftKey(state.owner), '')
  rpc.options.mockReset().mockResolvedValue(options)
  rpc.models.mockReset().mockResolvedValue({ harness: 'codex', models: [], efforts: [], selected: null, selectedEffort: null })
  rpc.create.mockReset()
})
afterEach(() => { harness.cleanup(); accountProjectsStore.clear() })

async function sendFirst() {
  await act(async () => { state.composer!.setText('原来的任务'); state.composer!.send() })
  expect(rpc.create).toHaveBeenCalledTimes(1)
}

describe('creation keeps its navigation and draft ownership', () => {
  it('settles a late successful creation without reopening a page the user left', async () => {
    const pending = deferred<SessionpageSessionCreateResult>()
    rpc.create.mockReturnValue(pending.promise)
    const onCreated = vi.fn()
    await harness.render(pageOn(device, { onBack: vi.fn(), onCreated }))
    await sendFirst()
    await harness.render(null)
    await act(async () => { pending.resolve(result); await pending.promise })
    expect(onCreated).not.toHaveBeenCalled()
    expect(composerDrafts.get(mobileCreationDraftKey(state.owner))).toBe('')
  })

  it('does not replace newer typing when the first creation fails', async () => {
    const pending = deferred<SessionpageSessionCreateResult>()
    rpc.create.mockReturnValue(pending.promise)
    await harness.render(pageOn(device, { onBack: vi.fn(), onCreated: vi.fn() }))
    await sendFirst()
    await act(async () => { state.composer!.setText('正在写下一句'); pending.reject(new Error('network unavailable')); await Promise.resolve() })
    expect(state.composer!.getState().text).toBe('正在写下一句')
    expect(harness.container.querySelector('[data-testid="agent-watch-create-error"]')).not.toBeNull()
  })

  it('does not offer or read an online phone whose host has stopped: it is not a machine to run on', async () => {
    const stoppedPhone = { ...device, platform: 'android', capabilities: { host_kind: 'phone', host_runtime_capability: 0, terminals: [], runtimes: [] } } as Device
    await harness.render(pageOn(stoppedPhone, { onBack: vi.fn(), onCreated: vi.fn() }))
    expect(rpc.options).not.toHaveBeenCalled()
    const machine = harness.container.querySelector<HTMLButtonElement>('[data-testid="agent-watch-create-target-row"][data-dimension="machine"]')!
    expect(machine.disabled).toBe(true)
  })

  // DESIGN 点击路径 4a:进来就有「不选项目 · 默认机器」;点项目行选 work,机器按默认规则换到有它文件夹的那台,发送带那台上的本地项目。
  it('opens with defaults; picking a project moves to a machine holding its folder and creates there', async () => {
    const folderOf = (id: string, path: string) => ({ localProjectId: id, name: 'work', rootPath: path, createdAt: '2026-11-01T00:00:00.000Z', chatId: 'chat-work', folders: [{ workspaceId: `ws-${id}`, kind: 'root' as const, path, attachedAt: null }] })
    const mac = { ...device, device_id: 'mac', label: 'mac' }
    const gpu = { ...device, device_id: 'gpu', label: 'gpu', projects: [folderOf('gpu-work', '/root/work')] }
    rpc.create.mockResolvedValue(result)
    const onCreated = vi.fn()
    store.devices = [mac, gpu]
    // The project list is the account project list (accountProjectsStore); its folder path is gpu's published record.
    runInAction(() => { accountProjectsStore.list = [{ chatId: 'chat-work', name: 'work', archived: false, bindings: [{ deviceId: 'gpu', localProjectId: 'gpu-work' }] }] })
    await harness.render(createNode(CreateSessionPage, { onBack: vi.fn(), onCreated }))
    const row = (dimension: string) => harness.container.querySelector<HTMLButtonElement>(`[data-testid="agent-watch-create-target-row"][data-dimension="${dimension}"]`)!
    expect(row('project').textContent).toContain('不选项目')
    expect(rpc.options).toHaveBeenLastCalledWith('mac')
    await act(async () => { row('project').click() })
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="agent-watch-create-target-choice"][data-option-id="chat-work"]')!.click() })
    expect(row('project').textContent).toContain('work')
    expect(rpc.options).toHaveBeenLastCalledWith('gpu')
    await sendFirst()
    expect(rpc.create).toHaveBeenCalledWith('gpu', expect.objectContaining({ projectId: 'gpu-work', prompt: '原来的任务' }))
    expect(onCreated).toHaveBeenCalledWith(gpu, expect.objectContaining({ conversationId: 'created-task' }), expect.anything(), result)
    // 记下这个项目上次用的机器(键 = 项目群),下次默认还是它。
    // The machine choice is remembered on the account (agentCreateDefaults.machineByProject), shared with other clients.
    await vi.waitFor(() => expect(rememberRunMachineCloud).toHaveBeenCalledWith('chat-work', 'gpu'))
  })
})
