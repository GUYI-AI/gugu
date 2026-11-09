// @vitest-environment jsdom
// #2000 merge blocker: a filled protocol-1 form must actually run its submit handler and reach
// authorization preparation plus the credential request. Everything between the form and the
// network is real: the setup dialog, SetupFormShell, IntegrationsProvider, LibraryHostProvider,
// connectionLibraryHost and ownerConnectionActions. Only the cloud client, the platform credential
// client and the device RPC are doubles.
import { createElement } from 'react'
import { QueryClient,QueryClientProvider } from '@tanstack/react-query'
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest'
import { createConnectionRouting,type ConnectionRoute } from '@gugu/core/cloud/connectionRouting'
import type { ConnectionClient,ConnectionCommit,ConnectionSnapshot } from '@gugu/core/cloud/connections'
import { clickElement,createReactHarness,typeInto } from '../../../support/testHarness'

const fixture = vi.hoisted(() => ({ bridge: {} as Record<string,unknown>,notify: vi.fn(),
  platform: { saveCredential: vi.fn(),list: vi.fn(),beginOAuth: vi.fn(),oauthStatus: vi.fn(),cancelOAuth: vi.fn() } }))
vi.mock('@/lib/notices',() => ({ notify: fixture.notify }))
vi.mock('@/lib/connectionBridge',() => ({ connectionBridge: () => fixture.bridge }))
vi.mock('@/lib/platformIntegrations',() => ({ rendererPlatformIntegrationsClient: () => fixture.platform }))
vi.mock('@/lib/openAuthorizationLink',() => ({ openAuthorizationLink: vi.fn() }))

import type { LibraryHost } from '@/session/renderer/features/library/library-host'
import { LOCAL_LIBRARY_HOST,LibraryHostProvider } from '@/session/renderer/features/library/library-host'
import type { ConnectionMetadataItem,ConnectionMetadataStore } from '@/components/connections/connection-metadata'
import { connectionLibraryHost } from '@/components/connections/connection-library-host'
import { ownerConnectionActions } from '@/components/connections/owner-connection-actions'
import { IntegrationSetupModal } from '@/session/renderer/features/integrations/integration-setup-modal'
import { Dialog,DialogContent } from '@/session/renderer/lib/ui/dialog'

const ticket = 'e8939ca7-ef3e-4474-a71c-76eb993b0a17'
const route: ConnectionRoute = { mode: 'owner',epoch: '1',phase: 'stable',acceptingNewOperations: true }
let harness: ReturnType<typeof createReactHarness>,queries: QueryClient

function setup() {
  const snapshot: ConnectionSnapshot = { version: 1,state: 'ready',revision: '0',items: [],application: [] }
  const recreateBegin = vi.fn<ConnectionClient['recreateBegin']>(async change => ({ recreationId: ticket,operationId: (change as { operationId?: string }).operationId ?? crypto.randomUUID(),
    expectedItemRevision: null,revision: '0',expiresAt: '2099-01-01T00:00:00Z' }))
  const commit = vi.fn(async (change: ConnectionCommit) => ({ operationId: change.operationId,scopeKey: change.scopeKey,resourceKey: change.resourceKey ?? 'resolved-key',revision: '1',status: 'applied' }))
  const client = { snapshot: vi.fn(async () => snapshot),recreateBegin,commit,
    application: vi.fn(async () => ({ status: 'available' })) } as unknown as ConnectionClient
  fixture.bridge = { accountId: () => 'owner',client,routing: createConnectionRouting({ accountId: () => 'owner',read: async () => route,changed: () => {} }) }
  const store: ConnectionMetadataStore = { ownerId: 'owner',authorityEpoch: '1',snapshot: async () => snapshot as never,peekSnapshot: () => snapshot as never,
    collection: async () => [] as ConnectionMetadataItem[],body: async () => new Uint8Array(),assertCurrent: () => {},invalidate: vi.fn(),
    change: vi.fn(),save: vi.fn() }
  const native = { ...LOCAL_LIBRARY_HOST.integrations,
    connect: vi.fn(async () => ({ success: true as const,accountId: 'asana-account' })),
    ownerAuthorizationBegin: vi.fn(async () => {}),ownerAuthorizationComplete: vi.fn(async () => {}),
    ownerAccounts: vi.fn(async () => [{ providerId: 'asana',accountId: 'asana-account',configured: true,publicMetadata: { version: 1,providerId: 'asana',accountId: 'asana-account' } }]),
    ownerAuthorizationCommit: vi.fn(async (input: { operationId: string; scopeKey: string; resourceKey?: string }) => ({ operationId: input.operationId,scopeKey: input.scopeKey,resourceKey: input.resourceKey ?? 'k',revision: '1',status: 'applied' })),
    ownerAuthorizationCommitBatch: vi.fn() }
  const base = { ...LOCAL_LIBRARY_HOST,integrations: native } as unknown as LibraryHost
  const host = ownerConnectionActions(base,connectionLibraryHost(base,store,async () => {}),'device-1',route)
  fixture.platform.saveCredential.mockResolvedValue({ ok: true })
  fixture.platform.list.mockResolvedValue([{ provider: 'amap',accounts: [{ accountId: 'amap-account',connected: true,updatedAt: '2026-11-09T00:00:00Z' }] }])
  return { host,native,recreateBegin,commit }
}

async function submit(host: LibraryHost,integration: string,values: Record<string,string>,editAccount?: { accountId: string; fields: Record<string,string> }) {
  const onSuccess = vi.fn(),onClose = vi.fn()
  await harness.render(createElement(QueryClientProvider,{ client: queries },
    createElement(LibraryHostProvider,{ value: host },createElement(Dialog,{ open: true },createElement(DialogContent,null,
      createElement(IntegrationSetupModal,{ host,integration: integration as never,onSuccess,onClose,...(editAccount ? { editAccount } : {}) }))))))
  await vi.waitFor(() => expect(document.querySelector('input')).toBeTruthy())
  for (const [id,value] of Object.entries(values)) await typeInto(document.querySelector<HTMLInputElement>(`#integration-field-${id}`)!,value)
  await clickElement(document.querySelector<HTMLButtonElement>('[data-slot="dialog-footer"] button:last-child')!)
  return { onSuccess,onClose }
}

beforeEach(() => {
  harness = createReactHarness(); queries = new QueryClient({ defaultOptions: { queries: { retry: false,gcTime: 0 } } })
  fixture.notify.mockClear(); for (const fn of Object.values(fixture.platform)) fn.mockReset()
})
afterEach(() => { harness.cleanup(); queries.clear() })

describe('owner protocol-1 form submission reaches authorization preparation and the credential request', () => {
  it('first save of a platform-kept form', async () => {
    const test = setup(),{ onSuccess } = await submit(test.host,'amap',{ apiKey: 'amap-secret' })
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledOnce())
    expect(test.recreateBegin).toHaveBeenCalledOnce()
    expect(fixture.platform.saveCredential).toHaveBeenCalledExactlyOnceWith('amap',{ apiKey: 'amap-secret' },{ connect: 'manual' })
    expect(test.recreateBegin.mock.invocationCallOrder[0]).toBeLessThan(fixture.platform.saveCredential.mock.invocationCallOrder[0]!)
    expect(test.commit).toHaveBeenCalledOnce()
    expect(fixture.notify).not.toHaveBeenCalledWith(expect.objectContaining({ tier: 'error' }))
  })
  it('reauthorization of a saved platform-kept account', async () => {
    const test = setup(),{ onSuccess } = await submit(test.host,'amap',{ apiKey: 'rotated' },{ accountId: 'amap-account',fields: {} })
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledOnce())
    expect(test.recreateBegin).toHaveBeenCalledOnce()
    expect(fixture.platform.saveCredential).toHaveBeenCalledExactlyOnceWith('amap',{ apiKey: 'rotated' },{ connect: 'manual' })
  })
  it('first save of a device-kept form', async () => {
    const test = setup(),{ onSuccess } = await submit(test.host,'asana',{ accessToken: 'asana-secret' })
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledOnce())
    expect(test.native.ownerAuthorizationBegin).toHaveBeenCalledOnce()
    expect(test.recreateBegin).toHaveBeenCalledOnce()
    expect(test.native.connect).toHaveBeenCalledExactlyOnceWith('asana',{ accessToken: 'asana-secret' },undefined,true)
    expect(test.recreateBegin.mock.invocationCallOrder[0]).toBeLessThan(test.native.connect.mock.invocationCallOrder[0]!)
    expect(test.native.ownerAuthorizationCommit).toHaveBeenCalledOnce()
  })
  it('reauthorization of a saved device-kept account', async () => {
    const test = setup(),{ onSuccess } = await submit(test.host,'asana',{ accessToken: 'rotated' },{ accountId: 'asana-account',fields: {} })
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledOnce())
    expect(test.native.ownerAuthorizationBegin).toHaveBeenCalledOnce()
    expect(test.native.connect).toHaveBeenCalledExactlyOnceWith('asana',{ accessToken: 'rotated' },'asana-account',true)
  })
})
