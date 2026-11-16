// @vitest-environment jsdom
// The assistant panel as a replica (@@@client-state-model): server-head revisions never go back, the on-device copy paints
// a cold start (async local), the session restore prefetches the account's panel (C7), and a read through a connection
// store nobody registered fails instead of hanging.
import { beforeEach, expect, it, vi } from 'vitest'
import type { AssistantPanelItem, AssistantPanelSnapshot } from '@gugu/core/cloud/assistantPanel'

const cloud = vi.hoisted(() => ({ snapshot: vi.fn(), mine: { agentId: 'assistant' as string | null }, bus: [] as Array<{ event: string; listener: (payload?: unknown) => void; onSubscribed?: () => void }> }))
vi.mock('@/components/assistant/assistant-panel-cloud', () => ({
  assistantPanelCloud: { snapshot: cloud.snapshot },
  assertAssistantPanelOwner: () => undefined,
  queueAssistantAppChange: vi.fn(),
}))
vi.mock('@/lib/myAssistant', () => ({ myAssistant: { fetch: async () => ({ agentId: cloud.mine.agentId, provisionDeviceId: null }) } }))
vi.mock('@/lib/realtimeChannel', () => ({
  subscribePrivateUserEventBus: (_owner: string, event: string, listener: (payload?: unknown) => void, options: { onSubscribed?: () => void }) => { cloud.bus.push({ event, listener, onSubscribed: options.onSubscribed }); return {} },
  unsubscribePrivateUserEventBus: () => undefined,
}))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }))
// The panel files the host makes: the cloud client it hands them (its snapshot is the one a commit reads after).
const files = vi.hoisted(() => ({ cloud: null as null | { snapshot: (id: string) => Promise<{ revision: string }> } }))
vi.mock('@gugu/core/cloud/assistantPanelFiles', async (original) => {
  const real = await original<typeof import('@gugu/core/cloud/assistantPanelFiles')>()
  return { ...real, createAssistantPanelFiles: (input: Parameters<typeof real.createAssistantPanelFiles>[0]) => {
    files.cloud = input.cloud as unknown as typeof files.cloud
    return real.createAssistantPanelFiles(input)
  } }
})

const { assistantPanel, assistantPanelReadCache } = await import('@/components/assistant/assistant-panel-replica')
// The shell's half: the panel bridge (the cloud read) and the session-restore prefetch (C7).
const { installAssistantPanelHost } = await import('@/components/assistant/assistant-panel-host')
installAssistantPanelHost()
const { assistantIntegrationDetail } = await import('@/components/assistant/assistant-panel-reads')
const { writeAssistantPanelSnapshotCopy } = await import('@/lib/assistantPanelBodies')
const { followRendererSession, queryClient } = await import('@/lib/replica')
const { publishRendererSession } = await import('@/lib/sessionPublication')

const item = (key: string, revision = '1'): AssistantPanelItem => ({ assistant_user_id: 'assistant', owner_user_id: 'owner', domain: 'memory', resource_key: key,
  device_id: 'home', revision, data: { relativePath: `${key}.md` }, body_item_id: null, body_sha256: null, deleted_at: null, observed_at: null, updated_at: '2026-11-15' })
const snap = (revision: string, items = [item('a')]): AssistantPanelSnapshot => ({ version: 1, revision, items, application: [] })
const signIn = (id: string) => publishRendererSession('SIGNED_IN', { user: { id }, access_token: 't' } as never)

beforeEach(() => {
  queryClient.clear()
  cloud.snapshot.mockReset().mockResolvedValue(snap('1'))
  signIn('owner')
  followRendererSession('SIGNED_IN', 'owner')
})

it('a read or a write never puts back an older server revision than the one shown (I3)', async () => {
  // The sign-in's prefetch has landed first (revision 1).
  await vi.waitFor(() => expect(assistantPanel.peek('assistant').state).toBe('value'))
  cloud.snapshot.mockResolvedValueOnce(snap('5', [item('new', '5')]))
  await assistantPanel.fetch('assistant')
  const cache = assistantPanelReadCache('owner', 'assistant')
  cache.saveSnapshot(snap('3', [item('old', '3')]))
  expect(cache.peekSnapshot()?.revision).toBe('5')
  cloud.snapshot.mockResolvedValueOnce(snap('4'))
  await assistantPanel.refresh('assistant')
  await assistantPanel.fetch('assistant')
  expect(cache.peekSnapshot()?.revision).toBe('5')
  cache.saveSnapshot(snap('6', [item('newest', '6')]))
  expect(cache.peekSnapshot()?.items[0]?.resource_key).toBe('newest')
  // A removal the cloud confirmed at a later revision leaves at once.
  cache.forget('memory', 'newest', '7')
  expect(cache.peekSnapshot()).toMatchObject({ revision: '7', items: [] })
})

it('the panel files\' snapshot after a write does not join a read that began before it (I2)', async () => {
  await vi.waitFor(() => expect(assistantPanel.peek('assistant').state).toBe('value'))
  // The sign-in's reads have all landed.
  await vi.waitFor(() => expect(assistantPanel.isFetching('assistant')).toBe(false))
  await new Promise((resolve) => setTimeout(resolve, 0))
  await vi.waitFor(() => expect(assistantPanel.isFetching('assistant')).toBe(false))
  // A read on its way (begun before the write).
  let before!: (value: AssistantPanelSnapshot) => void
  cloud.snapshot.mockReturnValueOnce(new Promise((resolve) => { before = resolve }))
  void assistantPanel.refresh('assistant')
  void assistantPanel.prefetch('assistant')
  await vi.waitFor(() => expect(assistantPanel.isFetching('assistant')).toBe(true))
  // The write landed (revision 4); the files ask the snapshot now.
  cloud.snapshot.mockResolvedValueOnce(snap('4'))
  const bridge = (window as unknown as { __GUGU_ASSISTANT_PANEL__: { files: (input: object) => unknown } }).__GUGU_ASSISTANT_PANEL__
  bridge.files({ ownerId: 'owner', assistantId: 'assistant', chatId: 'dm', deviceId: 'home' })
  const asked = files.cloud!.snapshot('assistant')
  // The earlier read answers with what it saw before the write.
  before(snap('3'))
  expect((await asked).revision).toBe('4')
  await vi.waitFor(() => expect(assistantPanel.isFetching('assistant')).toBe(false))
  expect(assistantPanel.peek('assistant')).toMatchObject({ state: 'value', value: { revision: '4' } })
})

it('the on-device copy is the first value of a cold start (async local), then the read replaces it', async () => {
  await writeAssistantPanelSnapshotCopy('owner', 'cold', { ...snap('2'), items: [{ ...item('kept'), assistant_user_id: 'cold' }] })
  let answer!: (value: AssistantPanelSnapshot) => void
  cloud.snapshot.mockReturnValueOnce(new Promise((resolve) => { answer = resolve }))
  void assistantPanel.prefetch('cold')
  await vi.waitFor(() => expect(assistantPanel.peek('cold')).toMatchObject({ state: 'value', stale: true, value: { revision: '2' } }))
  answer({ ...snap('3'), items: [] })
  await vi.waitFor(() => expect(assistantPanel.peek('cold')).toMatchObject({ state: 'value', value: { revision: '3' } }))
})

it('the session restore prefetches the account assistant\'s panel (C7)', async () => {
  await vi.waitFor(() => expect(assistantPanel.peek('assistant').state).toBe('value'))
  cloud.snapshot.mockClear().mockResolvedValue(snap('9'))
  publishRendererSession('INITIAL_SESSION', { user: { id: 'owner' }, access_token: 't' } as never)
  await vi.waitFor(() => expect(cloud.snapshot).toHaveBeenCalledWith('assistant'))
  await vi.waitFor(() => expect(assistantPanel.peek('assistant')).toMatchObject({ state: 'value', value: { revision: '9' } }))
})

it('a detail read through a store nobody registered rejects (❌ hangs, ❌ empty)', async () => {
  await expect(assistantIntegrationDetail.fetch('["nobody"]', 'mail', 'a'.repeat(64), 'en-US')).rejects.toThrow('not registered')
  expect(assistantIntegrationDetail.peek('["nobody"]', 'mail', 'a'.repeat(64), 'en-US').state).toBe('error')
})

/** Microtask turns (no clock) until `seen` holds; how many it took, so a negative check can wait at least as long. */
async function turnsUntil(seen: () => boolean): Promise<number> {
  let turn = 0
  for (; turn < 500 && !seen(); turn += 1) await Promise.resolve()
  expect(seen()).toBe(true)
  return turn
}
async function turns(count: number): Promise<void> { for (let turn = 0; turn < count; turn += 1) await Promise.resolve() }

it('a change on the bus reads the panel again — at once when ready, after the burst settles while a collection is prepared', async () => {
  await vi.waitFor(() => expect(assistantPanel.peek('assistant').state).toBe('value'))
  const ready = { ...item('__collection__'), data: { state: 'ready' } }
  cloud.snapshot.mockResolvedValue(snap('2', [ready]))
  await assistantPanel.refresh('assistant'); await assistantPanel.fetch('assistant')
  const stop = assistantPanel.hold('assistant')
  const changed = cloud.bus.filter((entry) => entry.event === 'assistant_panel_changed').at(-1)!
  cloud.snapshot.mockClear().mockResolvedValue(snap('3', [ready]))
  // This assistant's change: read at once — and how many turns that takes bounds the checks below.
  changed.listener({ assistantId: 'assistant' })
  const readStarts = await turnsUntil(() => cloud.snapshot.mock.calls.length > 0)
  await vi.waitFor(() => expect(assistantPanel.peek('assistant')).toMatchObject({ value: { revision: '3' } }))
  // Another assistant's change: no read, checked after the same path would have read twice over.
  cloud.snapshot.mockClear()
  changed.listener({ assistantId: 'another' })
  await turns(readStarts * 2 + 10)
  expect(cloud.snapshot).not.toHaveBeenCalled()
  // A collection still being prepared: the burst is read once it settles (1 s).
  vi.useFakeTimers()
  try {
    cloud.snapshot.mockClear().mockResolvedValue(snap('4', [item('filling')]))
    await assistantPanel.refresh('assistant'); await assistantPanel.fetch('assistant')
    cloud.snapshot.mockClear()
    changed.listener(); changed.listener(); changed.listener()
    await turns(readStarts * 2 + 10)
    expect(cloud.snapshot).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    await turns(readStarts * 2 + 10)
    expect(cloud.snapshot).toHaveBeenCalledTimes(1)
  } finally { vi.useRealTimers(); stop() }
})

it('a connection list shown through the legacy panel does not feed itself: reading it does not read it again', async () => {
  const { requireAssistantPanelBridge } = await import('@/lib/assistantPanelBridge')
  const { useConnectionList } = await import('@/components/assistant/assistant-panel-reads')
  const { createReactHarness } = await import('../../../support/testHarness')
  const { createElement } = await import('react')
  await vi.waitFor(() => expect(assistantPanel.peek('assistant').state).toBe('value'))
  const collection = { ...item('__collection__:home'), domain: 'integrations' as const, data: { state: 'ready' } }
  cloud.snapshot.mockReset().mockResolvedValue(snap('2', [collection]))
  const panel = requireAssistantPanelBridge().files({ ownerId: 'owner', assistantId: 'assistant', chatId: 'chat', deviceId: 'home' })
  // Every change of the panel entry; a loop is cut after 200 (signing out fails the next read) so the case ends either way.
  let changes = 0
  const stop = assistantPanel.subscribe(['assistant'], () => { if (++changes === 200) publishRendererSession('SIGNED_OUT', null) })
  const harness = createReactHarness()
  let reading: unknown
  function Probe() { reading = useConnectionList(panel as never, false, 'en-US'); return null }
  try {
    await harness.render(createElement(Probe))
    for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
    expect(changes).toBeLessThan(20)
    expect(cloud.snapshot.mock.calls.length).toBeLessThanOrEqual(2)
    // And the list it reads lands (❌ cancelled by its own refresh, unknown for good).
    expect(reading).toMatchObject({ state: 'value' })
  } finally { stop(); harness.cleanup({ keepReads: true }) }
})
