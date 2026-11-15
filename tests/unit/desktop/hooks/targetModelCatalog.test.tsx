// @vitest-environment jsdom
import { act } from 'react'
import { pluginRegistry } from '@gugu/session-plugins/agents'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { LibraryHostProvider, LOCAL_LIBRARY_HOST } from '@renderer/features/library/library-host'
import { useTargetModelCatalog } from '@renderer/lib/stores/use-target-model-catalog'
import { draftFastMode } from '@renderer/features/sessions/session-config/fast-mode'
import type { HarnessCatalogState } from '@renderer/lib/stores/use-harness-model-catalog'
import type { SessionpageLeg } from '@shared/core/sessions/sessions'

const read = vi.hoisted(() => vi.fn())
vi.mock('@renderer/lib/ipc', async importOriginal => ({
  ...await importOriginal<typeof import('@renderer/lib/ipc')>(),
  rpcOn: (machine: string | null) => ({ agents: { targetModelCatalog: (...args: unknown[]) => read(machine, ...args) } }),
}))

let harness: ReturnType<typeof createReactHarness>
let client: QueryClient
let current: HarnessCatalogState | undefined
let offered: boolean | undefined
function Probe({ model, provider = 'codex', leg = 'acp' }: { model: string; provider?: string; leg?: SessionpageLeg }) {
  current = useTargetModelCatalog(provider, leg, model)
  offered = draftFastMode({ enabled: false, capabilities: pluginRegistry.get(provider)?.capabilities, modelId: model, platformModel: null, catalog: current ?? { kind: 'unknown' } })
  return <div>{String(offered)}</div>
}
function tree(model: string, device = 'device-a', provider = 'codex', leg: SessionpageLeg = 'acp') {
  return <QueryClientProvider client={client}><LibraryHostProvider value={{ ...LOCAL_LIBRARY_HOST,
    remote: { deviceId: device, deviceLabel: device, online: true, lastSeenAt: null } }}>
    <Probe model={model} provider={provider} leg={leg} />
  </LibraryHostProvider></QueryClientProvider>
}
const native = (selected: string): HarnessCatalogState => ({ kind: 'ready', selected, models: [], efforts: [], selectedEffort: null,
  fastMode: { configId: 'fast', selected: 'off', available: [{ id: 'off', name: 'Off' }, { id: 'on', name: 'On' }] } })

beforeEach(() => { read.mockReset(); client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); harness = createReactHarness(); current = undefined; offered = undefined })
afterEach(() => { harness.cleanup(); client.clear() })

describe('selected model native Fast capability query', () => {
  it('offers Fast after probing the chosen nondefault model and ignores an older model reply', async () => {
    const old = Promise.withResolvers<HarnessCatalogState>(), next = Promise.withResolvers<HarnessCatalogState>()
    read.mockImplementation((_device, _provider, _leg, model) => model === 'model-a' ? old.promise : next.promise)
    await harness.render(tree('model-a'))
    await vi.waitFor(() => expect(read).toHaveBeenCalledWith('device-a', 'codex', 'acp', 'model-a'))
    await harness.render(tree('model-b'))
    await vi.waitFor(() => expect(read).toHaveBeenCalledWith('device-a', 'codex', 'acp', 'model-b'))
    expect(offered).toBeUndefined()
    await act(async () => { next.resolve(native('model-b')) })
    await vi.waitFor(() => expect(offered).toBe(false))
    await act(async () => { old.resolve(native('model-a')) })
    expect(current).toMatchObject({ kind: 'ready', selected: 'model-b' })
    expect(offered).toBe(false)
  })
  it('isolates facts by execution device, harness and leg as well as model', async () => {
    read.mockImplementation(async (_device, _provider, _leg, model) => native(model))
    await harness.render(tree('model-a'))
    await vi.waitFor(() => expect(offered).toBe(false))
    await harness.render(tree('model-a', 'device-b'))
    await vi.waitFor(() => expect(read).toHaveBeenCalledWith('device-b', 'codex', 'acp', 'model-a'))
    await harness.render(tree('model-a', 'device-b', 'claude', 'tui'))
    await vi.waitFor(() => expect(read).toHaveBeenCalledWith('device-b', 'claude', 'tui', 'model-a'))
    expect(client.getQueryCache().getAll().map(query => query.queryKey)).toEqual([
      ['agents', 'targetModelCatalog', 'device-a', 'codex', 'acp', 'model-a'],
      ['agents', 'targetModelCatalog', 'device-b', 'codex', 'acp', 'model-a'],
      ['agents', 'targetModelCatalog', 'device-b', 'claude', 'tui', 'model-a'],
    ])
  })
})
