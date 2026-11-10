// The backend retired cleanup_legacy_gugu_devices (it answers 0 for released clients): a device tick never calls it.
import { expect, test } from 'vitest'
import { createDeviceRuntimeHostLoop, type DeviceRuntimeIdentityClient } from '@gugu/core'
import { isolatedGuguEnv, MemoryRuntimeIdentityClient } from '../../../support/deviceRuntimeHarness'
import { until } from '../../../support/awaitCondition'

test('a device host tick calls no legacy device cleanup', async () => {
  const env = await isolatedGuguEnv('gugu-no-legacy-cleanup-')
  const client = new MemoryRuntimeIdentityClient([], { insertError: 'not used', singleError: 'not used' })
  const called: string[] = []
  const rpc = client.rpc.bind(client)
  client.rpc = (async (fn: string, args: Record<string, unknown>) => { called.push(fn); return rpc(fn, args) }) as typeof client.rpc
  const host = createDeviceRuntimeHostLoop({
    env, intervalMs: 15, superviseIntervalMs: 60_000, heartbeatIntervalMs: 20,
    machineIdentifier: () => 'no-legacy-cleanup-machine', capabilities: { terminals: [], runtimes: [] },
    authProvider: { getAuth: async () => ({ accessToken: 'token', userId: 'user-no-legacy-cleanup' }) },
    makeIdentityClient: () => client as unknown as DeviceRuntimeIdentityClient,
    runtimeBridge: { create: async () => {}, injectAgentInbox: async () => 'accepted' as const, stop: async () => {} },
    subscribeCommandWake: ({ onSubscribed }) => { onSubscribed?.(); return () => undefined },
  })
  host.start()
  try {
    await until('a few heartbeats landed', () => client.upserts.length >= 3)
  } finally { await host.stop() }
  expect(called.length).toBeGreaterThan(0)
  expect(called).not.toContain('cleanup_legacy_gugu_devices')
})
