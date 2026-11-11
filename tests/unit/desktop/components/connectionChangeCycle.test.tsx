// @vitest-environment jsdom
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionRoute } from '@gugu/core/cloud/connectionRouting'

/**
 * #1922 D8. An outside change and this window's announcement are two directions: the owner's change bus feeds
 * `subscribeChanges`, a reaction to it (`store.invalidate()`) announces `CONNECTIONS_CHANGED` once to this window's
 * readers, and nothing that hears the announcement emits again. With the old wiring `subscribeChanges` also heard the
 * announcement, and `invalidate` announced: a synchronous cycle that filled the renderer's heap.
 */
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const OWNER = '11000000-0000-4000-8000-000000000001'
const net = vi.hoisted(() => ({
  bus: [] as (() => void)[],
  calls: [] as string[],
  revision: 1,
  held: undefined as Promise<unknown> | undefined,
}))
const ROUTE = { mode: 'owner', epoch: '1', phase: 'stable', acceptingNewOperations: true } as const
const ITEM_SOURCE = { scopeKey: 'device:d1', resourceKey: 'account-1' }
function answer(name: string, args: Record<string, unknown>) {
  if (name === 'connection_authority') return { version: 1, ...ROUTE }
  if (name === 'connection_snapshot') return { version: 1, state: 'ready', revision: String(net.revision), application: [], items: [{
    ...ITEM_SOURCE, deviceId: 'd1', revision: String(net.revision), data: { providerId: 'github', accountId: 'a', configured: true }, publicMetadata: null,
    document: null, bodySha256: null, deletedAt: null, staleAt: null, observedAt: null, updatedAt: '2026-11-11T00:00:00Z',
  }] }
  if (name === 'connection_commit') return { operationId: args.p_operation_id, revision: String(net.revision + 1), status: 'applied', scopeKey: args.p_scope_key, resourceKey: args.p_resource_key }
  throw new Error(`unexpected ${name}`)
}
vi.mock('@/lib/sessionPublication', () => ({ getRendererSession: () => ({ user: { id: OWNER } }), observeRendererSession: () => () => {} }))
vi.mock('@/lib/supabase', () => ({ identityDb: { rpc: (name: string, args: Record<string, unknown>) => ({ abortSignal: async () => {
  net.calls.push(name)
  // What the backend held when the read arrived, handed back later if the read is held.
  const data = answer(name, args)
  if (name === 'connection_snapshot' && net.held) await net.held
  return { data, error: null, status: 200 }
} }) } }))
vi.mock('@/lib/realtimeChannel', () => ({
  subscribePrivateUserEventBus: (_owner: string, _event: string, listener: () => void) => { net.bus.push(listener); return net.bus.length },
  unsubscribePrivateUserEventBus: () => {},
}))
vi.mock('@/components/assistant/assistant-panel-cache', () => ({ assistantPanelCacheStore: () => ({ accountState: () => {
  let saved: unknown
  return { peek: () => saved, save: (value: unknown) => { saved = value } }
} }) }))
vi.mock('@/lib/platformIntegrations', () => ({ rendererPlatformIntegrationsClient: () => ({}) }))
vi.mock('@/components/connections/useConnectionReadNotice', () => ({ useConnectionReadNotice: () => {} }))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ warn: () => {}, info: () => {}, error: () => {} }) }))

const { installConnectionHost } = await import('@/components/connections/connection-host')
const { connectionBridge, useConnectionAuthority, useOwnerConnectionStore } = await import('@/lib/connectionBridge')
const { CONNECTIONS_CHANGED } = await import('@/components/connections/owner-connection-metadata')
const { ownerConnectionResourceKey } = await import('@/components/connections/owner-connection-store')
installConnectionHost(window)

let root: Root
let container: HTMLDivElement
let announced = 0
const count = () => { announced += 1 }
const settle = () => act(async () => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve() })
/** The two hooks as the settings page, the App's 资料 and the phone mount them; a reader as the integrations list reads. */
function Page({ onRead }: { onRead?: (revision: string) => void }) {
  useConnectionAuthority()
  const store = useOwnerConnectionStore(null, ROUTE as ConnectionRoute, true)
  useEffect(() => {
    if (!store || !onRead) return
    const read = () => { void store.snapshot().then(value => onRead(value.revision), () => {}) }
    read()
    window.addEventListener(CONNECTIONS_CHANGED, read)
    return () => window.removeEventListener(CONNECTIONS_CHANGED, read)
  }, [store, onRead])
  return null
}
const outsideChange = () => act(() => { for (const listener of [...net.bus]) listener() })

beforeEach(() => {
  Object.assign(net, { bus: [], calls: [], revision: 1, held: undefined })
  announced = 0
  window.addEventListener(CONNECTIONS_CHANGED, count)
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  window.removeEventListener(CONNECTIONS_CHANGED, count)
})

describe('one outside change', () => {
  it('is announced to this window once, and the announcement is never heard as another outside change', async () => {
    await act(async () => root.render(<Page />))
    await settle()
    const before = announced
    outsideChange()
    await settle()
    // One re-read for each hook that heard the bus (the store's), zero re-emits.
    expect(announced - before).toBe(1)
  })

  it('makes the readers read the new state — a read already under way is not joined — and the authority read again', async () => {
    const revisions: string[] = []
    await act(async () => root.render(<Page onRead={revision => revisions.push(revision)} />))
    await settle()
    expect(revisions).toEqual(['1'])
    let release: () => void = () => {}
    net.held = new Promise<void>(resolve => { release = () => resolve() })
    const store = connectionBridge().metadata(OWNER, null, ROUTE as ConnectionRoute)
    const stale = store.snapshot()
    await settle()
    net.revision = 2
    net.held = undefined
    const authorityBefore = net.calls.filter(name => name === 'connection_authority').length
    outsideChange()
    await settle()
    release()
    await act(async () => { await stale })
    await settle()
    expect(revisions.at(-1)).toBe('2')
    expect(net.calls.filter(name => name === 'connection_authority').length).toBeGreaterThan(authorityBefore)
  })
})

describe('a change made here', () => {
  const item = () => ({ owner_user_id: OWNER, domain: 'integrations' as const, resource_key: ownerConnectionResourceKey(ITEM_SOURCE.scopeKey, ITEM_SOURCE.resourceKey),
    source: ITEM_SOURCE, device_id: 'd1', revision: '1', data: { providerId: 'github', accountId: 'a', configured: true },
    body_item_id: null, body_sha256: null, deleted_at: null, observed_at: null, updated_at: '2026-11-11T00:00:00Z' })

  it('tells the others exactly once — a save, and a change', async () => {
    await act(async () => root.render(<Page />))
    await settle()
    const store = connectionBridge().metadata(OWNER, null, ROUTE as ConnectionRoute)
    const busBefore = net.bus.length
    let before = announced
    await act(async () => { await store.save(item(), { providerId: 'github', accountId: 'a', configured: true }) })
    await settle()
    expect(announced - before).toBe(1)
    before = announced
    await act(async () => { await store.change(item(), 'disable') })
    await settle()
    expect(announced - before).toBe(1)
    expect(net.bus.length).toBe(busBefore)
  })
})
