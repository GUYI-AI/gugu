// 心跳诊断日志(只记日志,不改行为)。预发 11-08 三段心跳没落库而本机日志无失败 ⇒ 要能分清:
// 进程卡住(定时器晚到) / 心跳没发出或没写成(两次落库间隔过长) / 写被吞(0 行,见 deviceHeartbeatCapabilities)。
import { describe, expect, test } from 'vitest'
import { createDeviceRuntimeHostLoop, type DeviceRuntimeIdentityClient } from '@gugu/core'
import { isolatedGuguEnv, MemoryRuntimeIdentityClient } from '../../../support/deviceRuntimeHarness'
import { until } from '../../../support/awaitCondition'

async function run(jumpMs: number) {
  const env = await isolatedGuguEnv('gugu-heartbeat-diag-')
  const client = new MemoryRuntimeIdentityClient([], { insertError: 'not used', singleError: 'not used' })
  let offset = 0
  const warnings: string[] = []
  const host = createDeviceRuntimeHostLoop({
    env,
    intervalMs: 15,
    superviseIntervalMs: 60_000,
    heartbeatIntervalMs: 20,
    nowMs: () => Date.now() + offset,
    warn: (message) => warnings.push(message),
    machineIdentifier: () => 'heartbeat-diag-machine',
    capabilities: { terminals: [], runtimes: [] },
    authProvider: { getAuth: async () => ({ accessToken: 'token', userId: 'user-heartbeat-diag' }) },
    makeIdentityClient: () => client as unknown as DeviceRuntimeIdentityClient,
    runtimeBridge: { create: async () => {}, injectAgentInbox: async () => 'accepted' as const, stop: async () => {} },
    subscribeCommandWake: ({ onSubscribed }) => {
      onSubscribed?.()
      return () => undefined
    },
  })
  const writes = () => client.upserts.length
  host.start()
  try {
    await until('first heartbeat landed', () => writes() >= 1 && !host.getDebugSnapshot().ticking)
    await until('steady heartbeats land', () => writes() >= 3)
    const before = writes()
    offset += jumpMs
    await until('a heartbeat lands after the jump', () => writes() >= before + 2)
  } finally {
    await host.stop()
  }
  return warnings
}

const late = (w: string[]) => w.filter((m) => m.includes('heartbeat timer fired'))
const gap = (w: string[]) => w.filter((m) => m.includes('after the previous landed heartbeat'))

describe('device heartbeat diagnostics', () => {
  test('steady beats: no lag or gap warning', async () => {
    const warnings = await run(0)
    expect(late(warnings)).toEqual([])
    expect(gap(warnings)).toEqual([])
  })

  test('timer fires > 5 s late: warns with the lag, no landed-gap warning under 60 s', async () => {
    const warnings = await run(6_000)
    expect(late(warnings)).toHaveLength(1)
    expect(Number(/fired (\d+) ms late/.exec(late(warnings)[0])?.[1])).toBeGreaterThanOrEqual(6_000)
    expect(gap(warnings)).toEqual([])
  })

  test('two landed heartbeats > 60 s apart: warns with the actual gap', async () => {
    const warnings = await run(61_000)
    expect(gap(warnings)).toHaveLength(1)
    expect(Number(/landed (\d+) ms after/.exec(gap(warnings)[0])?.[1])).toBeGreaterThan(60_000)
  })
})
