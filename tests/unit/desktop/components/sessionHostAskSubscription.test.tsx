// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'

/** A remote host's Ask can be reread after a subscription is lost across a restart. */
const fx = vi.hoisted(() => ({
  settlements: [] as unknown[],
  snapshots: 0,
  subscribes: 0,
  cursor: { epoch: 'e1', seq: 0 },
  listener: null as ((event: { result: unknown }) => void) | null,
}))

vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', () => ({
  events: { on: (_event: unknown, cb: (event: { result: unknown }) => void) => { fx.listener = cb; return () => { fx.listener = null } } },
  rpc: {},
  rpcOn: () => ({
    sessionTimeline: {
      sessionSnapshot: async () => {
        fx.snapshots += 1
        return { ok: true, value: { settlements: fx.settlements, cursor: fx.cursor } }
      },
      sessionSubscribe: async () => { fx.subscribes += 1; return { ok: true } },
      sessionUnsubscribe: async () => ({ ok: true }),
    },
  }),
}))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: () => 'cloud' } }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/remote-hosts/remote-hosts-store', () => ({ remoteHostsStore: { device: () => null } }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/hooks/use-toast', () => ({ toast: () => undefined }))
vi.mock('../../../../apps/desktop/src/session/renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }))
vi.mock('../../../../apps/desktop/src/session/renderer/utils/logger', () => ({ log: { warn: () => undefined, debug: () => undefined } }))

import { useSessionHostAsk } from '../../../../apps/desktop/src/session/renderer/features/extensions/use-session-host-ask'

const APP_INSTALL = ['app-install'] as const
const QUESTION = {
  itemId: 'ask-1', state: 'pending', optionId: null, resolvedBy: null, resolvedAt: null,
  options: [{ optionId: 'install', name: 'Install' }, { optionId: 'decline', name: 'Decline' }],
  origin: { source: 'app-install', payload: { request: {
    requestId: 'ask-1', sourceDir: '/tmp/reader', manifest: { id: 'reader', name: 'Reader' },
    manifestDigest: 'reader-digest', revokedPermissions: [], given: { first: true },
  } } },
}

function Probe() {
  const ask = useSessionHostAsk('task-1', APP_INSTALL)
  return createNode('span', { 'data-ask': ask?.itemId ?? 'none' })
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() })
}
/** A timeline batch event, as the subscription channel delivers it. */
const batch = async (from: number, cursor: { epoch: string; seq: number }, settlements: unknown[] = []) => {
  await act(async () => {
    fx.listener?.({ result: { ok: true, batch: { from, cursor, settlements, turns: [], removedTurnIds: [] } } })
  })
}

describe('a watched session’s host ask is read again, not left to a subscription that may be gone', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(() => {
    harness = createReactHarness()
    vi.useFakeTimers()
    fx.settlements = []
    fx.snapshots = 0
    fx.subscribes = 0
    fx.cursor = { epoch: 'e1', seq: 0 }
    fx.listener = null
  })
  afterEach(() => {
    harness.cleanup()
    vi.useRealTimers()
  })

  it('reads one snapshot and leaves later updates to the subscription', async () => {
    await harness.render(createNode(Probe, {}))
    await settle()
    await act(async () => { vi.advanceTimersByTime(20_000) })
    await settle()
    expect(fx.snapshots).toBe(1)
  })

  it('a batch on another epoch — the new-session stand-in — reloads and the ask appears (#3588)', async () => {
    await harness.render(createNode(Probe, {}))
    await settle()
    expect(fx.snapshots).toBe(1)
    expect(fx.subscribes).toBe(1)
    // The stand-in's one and only delivery: another epoch's cursor, then this subscription stays silent forever.
    fx.cursor = { epoch: 'e2', seq: 0 }
    fx.settlements = [QUESTION]
    await batch(0, { epoch: 'other', seq: 1 })
    await settle()
    expect(fx.snapshots).toBe(2)
    expect(fx.subscribes).toBe(2)
    expect(harness.container.querySelector('[data-ask]')?.getAttribute('data-ask')).toBe('ask-1')
  })

  it('a batch that skips ahead of the held cursor reloads the same way', async () => {
    await harness.render(createNode(Probe, {}))
    await settle()
    await batch(4, { epoch: 'e1', seq: 5 })
    await settle()
    expect(fx.snapshots).toBe(2)
    expect(fx.subscribes).toBe(2)
  })

  it('a continuing batch on the same epoch still merges without reloading', async () => {
    await harness.render(createNode(Probe, {}))
    await settle()
    await batch(0, { epoch: 'e1', seq: 1 }, [QUESTION])
    await settle()
    expect(fx.snapshots).toBe(1)
    expect(fx.subscribes).toBe(1)
  expect(harness.container.querySelector('[data-ask]')?.getAttribute('data-ask')).toBe('ask-1')
  })
})
