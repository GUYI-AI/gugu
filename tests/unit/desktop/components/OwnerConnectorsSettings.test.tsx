// @vitest-environment jsdom
import { act,createElement,type ReactNode } from 'react'
import { QueryClient,QueryClientProvider } from '@tanstack/react-query'
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest'
import { clickElement,createReactHarness,renderWithAppProviders } from '../../../support/testHarness'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'

const fixture = vi.hoisted(() => ({ data: {} as Record<string,unknown>,rows: [] as unknown[],snapshotFails: false,change: vi.fn(async () => ({ status: 'pending' })),
  notify: vi.fn(),showSetup: vi.fn(),showGithub: vi.fn(),showConfirm: vi.fn(),retryOperation: vi.fn(async () => {}) }))
vi.mock('@/lib/notices',() => ({ notify: fixture.notify }))
vi.mock('@/lib/useAssistantHome',() => ({ useAssistantHome() { throw new Error('Unexpected assistant initialization') } }))
vi.mock('@/hooks/useMobileShell',() => ({ useMobileShell: () => true, readMobileShell: () => true }))
vi.mock('@/store/devicesContext',() => ({ useDevicesStore: () => ({ devices: [],loading: false,error: null }) }))
// No chat channels client in this build: the `chatChannels` replica reads `absent`.
vi.mock('@/lib/chatChannels',() => ({ rendererChatChannelsClient: () => null }))
// The owner snapshot the page derives from (the `ownerConnections` replica reads it through the bridge's store).
const snapshotOf = () => ({ version: 1,revision: '1',items: fixture.rows,application: fixture.data.connectionOperations ?? [] })
vi.mock('@/components/connections/useOwnerLibraryHost',() => ({ useOwnerLibraryHost: () => ({ key: 'owner:scope',remote: null,
  connectionMetadata: { ownerId: 'owner',authorityEpoch: '1',collection: async () => fixture.rows,change: fixture.change,invalidate: vi.fn(),
    snapshot: async () => snapshotOf() } }) }))
vi.mock('@/lib/connectionBridge',() => ({ connectionBridge: () => ({ retryOperation: fixture.retryOperation,
  routing: { peek: () => ({ mode: 'owner',epoch: '1' }) },metadata: () => ({ snapshot: async () => {
    if (fixture.snapshotFails) throw new Error('snapshot unreachable')
    return snapshotOf()
  } }) }) }))
vi.mock('@/session/renderer/features/library/library-host',() => ({ LibraryHostProvider: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/session/renderer/features/integrations/integrations-provider',() => ({ IntegrationsProvider: ({ children }: { children: ReactNode }) => children,
  useIntegrationsContext: () => fixture.data }))
vi.mock('@/session/renderer/features/integrations/integration-icon',() => ({ IntegrationIcon: () => null }))
vi.mock('@/session/renderer/lib/modal/modal-provider',() => ({ useShowModal: (name: string) => name === 'confirmActionModal'
  ? fixture.showConfirm : name === 'githubConnectModal' ? fixture.showGithub : fixture.showSetup }))

import { ConnectionMutationContext } from '../../../../apps/desktop/src/components/connections/connection-mutation-context'
import { OwnerConnectorsSettings } from '../../../../apps/desktop/src/components/connections/OwnerConnectorsSettings'
import { ownerConnections } from '../../../../apps/desktop/src/components/connections/connection-replicas'
import { publishRendererSession } from '../../../../apps/desktop/src/lib/sessionPublication'
import type { Session } from '@supabase/supabase-js'
let harness: ReturnType<typeof createReactHarness>,client: QueryClient,sequence = 0
const app = (id: string,custody?: 'platform') => ({ id,name: id === 'github' ? 'GitHub' : '高德地图',description: '说明',catalog: { categoryId: 'dev' },
  icon: { kind: 'svg',variants: [] },auth: { methods: custody ? [{ kind: 'form',custody,fields: [] }] : [] },capabilities: {},abilities: [],playbooks: [],features: [] })
beforeEach(() => {
  harness = createReactHarness(); client = new QueryClient({ defaultOptions: { queries: { retry: false,gcTime: 0 } } }); sequence += 1
  fixture.rows = []; fixture.snapshotFails = false; fixture.notify.mockClear(); fixture.change.mockReset(); fixture.change.mockResolvedValue({ status: 'pending' }); fixture.showSetup.mockClear(); fixture.showGithub.mockClear(); fixture.showConfirm.mockClear(); fixture.retryOperation.mockClear()
  fixture.data = { integrations: [app('github'),app('amap','platform')],configuredConnections: {},connectionStatus: {},
    configuredConnectionsError: null,connectionCheckError: null,reloadConnections: vi.fn(),connectionOperations: [] }
  publishRendererSession('SIGNED_IN',{ user: { id: `owner-${sequence}` },access_token: 'fixture' } as Session)
})
afterEach(() => { harness.cleanup(); client.clear(); publishRendererSession('SIGNED_OUT',null) })
const render = (allowed = true) => renderWithAppProviders(harness,createElement(QueryClientProvider,{ client },createElement(ConnectionMutationContext,{ value: allowed },createElement(OwnerConnectorsSettings,{ route: { mode: 'owner',epoch: '1',phase: 'stable',acceptingNewOperations: true } }))),{ auth: { id: `owner-${sequence}` } })
const q = (id: string) => harness.container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!

describe('owner connection settings without an assistant or native host', () => {
  it('opens the complete catalog and platform authorization with no assistant/home/selected device', async () => {
    await render()
    expect(q('assistant-connector-github')).toBeTruthy()
    await clickElement(q('assistant-connector-amap'))
    await clickElement(q('assistant-connector-connect'))
    expect(fixture.showSetup).toHaveBeenCalledWith(expect.objectContaining({ integration: 'amap' }))
    expect(fixture.showGithub).not.toHaveBeenCalled()
  })
  it('asks for an actual device before opening native authorization', async () => {
    await render()
    await clickElement(q('assistant-connector-github'))
    await clickElement(q('assistant-connector-connect'))
    expect(fixture.notify).toHaveBeenCalledWith(expect.objectContaining({ tier: 'error',title: 'GitHub需要一台设备，请先选择设备再授权。' }))
    expect(fixture.showGithub).not.toHaveBeenCalled()
  })
  it('preserves the exact scoped account when equal account ids exist on two devices', async () => {
    fixture.rows = ['one','two'].map(device => ({ owner_user_id: 'owner',domain: 'integrations',resource_key: JSON.stringify([`device:${device}`,'same-key']),
      source: { scopeKey: `device:${device}`,resourceKey: 'same-key' },device_id: device,revision: '5',data: { providerId: 'github',accountId: 'same-account',displayName: device } }))
    await render(); await clickElement(q('assistant-connector-github'))
    await act(async () => { await vi.waitFor(() => expect(harness.container.textContent).toContain('one')) })
    const disconnect = [...harness.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '断开连接')!
    await clickElement(disconnect)
    await act(async () => { await fixture.showConfirm.mock.calls[0]![0].onSuccess(); await new Promise(resolve => setTimeout(resolve,0)) })
    await vi.waitFor(() => expect(fixture.change).toHaveBeenCalledExactlyOnceWith(fixture.rows[0],'remove'))
  })
  it('automatically replaces an application pending row only when a confirmed account state arrives',async () => {
    fixture.rows = [{ resource_key: '["device:one","github-key"]',data: { providerId: 'github' } }]
    fixture.data.connectionOperations = [{ resourceKey: '["device:one","github-key"]',revision: '5',operation: 'save',status: 'pending',terminal: false }]
    await render()
    await act(async () => { await vi.waitFor(() => expect(ownerConnections.peek('1',null).state).toBe('value')) })
    await clickElement([...harness.container.querySelectorAll<HTMLElement>('[role="tab"]')].find(tab => tab.textContent === '我的连接')!)
    expect(q('assistant-connector-github').textContent).toContain('正在确认授权')
    fixture.data = { ...fixture.data,connectionOperations: [],configuredConnections: { github: true },connectionStatus: { github: { connected: true } } }
    await act(async () => { await ownerConnections.refresh() })
    await render()
    expect(q('assistant-connector-github')).toBeTruthy()
    expect(q('assistant-connector-github').textContent).not.toContain('正在确认授权')
  })
  it('places an unknown authorization on its application row without a generic operation or retry button',async () => {
    fixture.rows = [{ resource_key: '["device:one","github-key"]',data: { providerId: 'github' },deleted_at: 'now' }]
    fixture.data.connectionOperations = [{ resourceKey: '["device:one","github-key"]',revision: '5',operation: 'save',status: 'failed',terminal: true,errorCode: 'CONNECTION_OUTCOME_UNKNOWN' }]
    await render()
    await act(async () => { await vi.waitFor(() => expect(ownerConnections.peek('1',null).state).toBe('value')) })
    const mine = [...harness.container.querySelectorAll<HTMLElement>('[role="tab"]')].find(tab => tab.textContent === '我的连接')!
    await clickElement(mine)
    expect(q('assistant-connector-github').textContent).toContain('GitHub: 状态待确认')
    expect(harness.container.textContent).not.toMatch(/连接操作|核实|重试/)
    expect(harness.container.querySelectorAll('[role="tab"][aria-selected="true"]')).toHaveLength(1)
    await clickElement(q('assistant-connector-github'))
    expect((q('assistant-connector-connect') as HTMLButtonElement).disabled).toBe(true)
  })
  it('reports the application and failed user action through the unified notice only',async () => {
    fixture.rows = [{ domain: 'integrations',resource_key: 'platform-key',data: { providerId: 'amap',accountId: 'one' },source: { scopeKey: 'platform' } }]
    fixture.change.mockRejectedValue(new Error('503'))
    await render(); await clickElement(q('assistant-connector-amap'))
    await vi.waitFor(() => expect(harness.container.textContent).toContain('断开连接'))
    await clickElement([...harness.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '断开连接')!)
    await act(async () => { await fixture.showConfirm.mock.calls[0]![0].onSuccess() })
    expect(fixture.notify).toHaveBeenCalledWith({ key: 'connections-action:owner:amap',tier: 'error',title: '高德地图没能完成断开，请稍后查看连接状态。' })
    expect(harness.container.querySelector('[role="alert"]')).toBeNull()
  })
  it('disables new actions while leaving browsing usable during the switch',async () => {
    await render(false)
    await clickElement(q('assistant-connector-amap'))
    expect((q('assistant-connector-connect') as HTMLButtonElement).disabled).toBe(true)
    expect(harness.container.textContent).not.toContain('正在切换')
  })
  it('keeps cached application state without read failure text or retry controls',async () => {
    fixture.data.configuredConnections = { github: true }
    fixture.data.connectionStatus = { github: { connected: true } }
    fixture.data.configuredConnectionsError = { code: '42501' }
    fixture.data.connectionCheckError = { code: '42501' }
    await render()
    await clickElement([...harness.container.querySelectorAll<HTMLElement>('[role="tab"]')].find(tab => tab.textContent === '我的连接')!)
    expect(q('assistant-connector-github')).toBeTruthy()
    expect(harness.container.textContent).not.toMatch(/重试|无法读取|校验失败/)
    expect(fixture.notify).not.toHaveBeenCalled()
  })
  it('keeps failed reads distinct from an empty My connections list', async () => {
    fixture.data.configuredConnections = null; fixture.data.configuredConnectionsError = { code: 'not-ready' }
    await render()
    const mine = [...harness.container.querySelectorAll<HTMLElement>('[role="tab"]')].find(tab => tab.textContent === '我的连接')!
    await clickElement(mine)
    expect(q('application-list-pending')).toBeTruthy()
    expect(harness.container.textContent).not.toMatch(/重试|没读到|尚未准备好/)
    expect(q('connected-apps-empty')).toBeNull()
  })
  it('a snapshot read before whose read again fails keeps the rows and accounts and says the failure with a retry (list and detail)', async () => {
    fixture.rows = [{ owner_user_id: 'owner',domain: 'integrations',resource_key: JSON.stringify(['device:one','github-key']),
      source: { scopeKey: 'device:one',resourceKey: 'github-key' },device_id: 'one',revision: '5',data: { providerId: 'github',accountId: 'acc',displayName: 'octo' } }]
    await render()
    await act(async () => { await vi.waitFor(() => expect(ownerConnections.peek('1',null).state).toBe('value')) })
    expect(harness.container.querySelector('[data-refresh-failed]')).toBeNull()
    fixture.snapshotFails = true
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await act(async () => {
        const read = ownerConnections.refresh('1',null).catch(() => undefined)
        await vi.advanceTimersByTimeAsync(60_000)
        await read
      })
    } finally { vi.useRealTimers() }
    await vi.waitFor(() => expect(harness.container.querySelector('[data-refresh-failed]')).not.toBeNull())
    expect(q('assistant-connector-github')).toBeTruthy()
    await clickElement(q('assistant-connector-github'))
    expect(harness.container.textContent).toContain('octo')
    expect(harness.container.querySelector('[data-refresh-failed]')).not.toBeNull()
  })
})
