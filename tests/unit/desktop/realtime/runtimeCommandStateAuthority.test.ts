import { expect, test } from 'vitest'
import { createDeviceRuntimeHostLoop, deterministicDeviceId, type DeviceRuntimeIdentityClient } from '@gugu/core'
import type { AgentStatusReading } from '@gugu/core/shared/agentStatus'
import { awaitFact } from '../../../support/awaitFact'
import { deviceCommandRow, isolatedGuguEnv, pollOnlyRuntimeIdentityClient, testAgentCreatePayload } from '../../../support/deviceRuntimeHarness'

test('agent.create completion publishes the admitted session reading instead of an invented idle', async () => {
  const env = await isolatedGuguEnv('gugu-command-state-authority-')
  const machine = 'command-state-authority'
  const owner = 'owner-1'
  const device = deterministicDeviceId(machine, owner)
  const command = deviceCommandRow({ deviceId: device, type: 'agent.create', payload: testAgentCreatePayload({ first_task: 'do the first task' }) })
  const client = pollOnlyRuntimeIdentityClient([command], 'command state authority')
  const original = client.rpc.bind(client)
  const writes: Record<string, unknown>[] = []
  client.rpc = async (name: string, args: Record<string, unknown>) => {
    if (name === 'set_agent_runtime_state') writes.push(args)
    return original(name, args)
  }
  let reading: AgentStatusReading | null = null
  const host = createDeviceRuntimeHostLoop({
    env, machineIdentifier: () => machine, capabilities: { terminals: [], runtimes: [] },
    authProvider: { getAuth: async () => ({ accessToken: 'token', userId: owner }) },
    makeIdentityClient: () => client as unknown as DeviceRuntimeIdentityClient,
    subscribeCommandWake: () => () => {},
    runtimeBridge: {
      create: async () => {}, stop: async () => {}, agentStatus: () => reading,
      startAgentSession: async input => {
        // Production returns once session-life has admitted creation, without waiting for that turn to finish.
        reading = { status: 'working', detail: 'running', running: true, background: null }
        return { guguAgentUserId: input.agentUserId, chatId: input.chatId, sessionId: 'session', projectId: 'project', created: true }
      },
    },
  })
  host.start()
  try {
    await awaitFact('agent.create terminal receipt', async () => command.status === 'done' ? true : undefined)
    expect(writes).not.toHaveLength(0)
    for (const row of writes) expect(row).toMatchObject({ p_activity_status: 'running', p_agent_status: 'working', p_agent_status_detail: 'running' })
  } finally { await host.stop() }
})
