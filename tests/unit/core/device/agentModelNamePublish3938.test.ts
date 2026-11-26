// #3938 The model an agent runs travels on its presence write (`p_model_name`): the host publishes it with the
// reading, a write that says nothing about it (null) changes nothing the cloud holds, and '' clears it.
import { describe, expect, it } from 'vitest'
import type { AgentStatusReading } from '@gugu/core/shared/agentStatus'
import { createAgentRuntimeStateReporter } from '@gugu/core/cloud/agentRuntimeStateReporter'
import {
  createAgentRuntimeStatePublisher,
  publishAgentStatusTransitions,
  publishedStatusOf,
  samePublishedStatus,
  type PublishedAgentStatus,
} from '@gugu/core/cloud/deviceRuntimeSweep'

const idle: AgentStatusReading = { status: 'idle', detail: null, running: false, background: null }

function recordingClient() {
  const calls: Record<string, unknown>[] = []
  return {
    calls,
    client: { rpc: async (_fn: 'set_agent_runtime_state', args: Record<string, unknown>) => { calls.push(args); return { error: null } } },
  }
}

describe('#3938 the reporter carries the model name', () => {
  it('sends it as p_model_name, and null when the write says nothing about it', async () => {
    const { calls, client } = recordingClient()
    const report = createAgentRuntimeStateReporter(client)
    await report({ agentUserId: 'a', activityStatus: 'idle', modelName: 'Opus 5.5' })
    await report({ agentUserId: 'a', activityStatus: 'idle' })
    await report({ agentUserId: 'a', activityStatus: 'idle', modelName: '' })
    expect(calls.map((args) => args.p_model_name)).toEqual(['Opus 5.5', null, ''])
  })
})

describe('#3938 publishing compares the model with what the cloud holds', () => {
  it('a next value that says nothing about the model is the same publication; a different model is not', () => {
    const published = publishedStatusOf(idle, null, 'Opus 5.5')
    expect(samePublishedStatus(published, publishedStatusOf(idle, null, null))).toBe(true)
    expect(samePublishedStatus(published, publishedStatusOf(idle, null, 'Opus 5.5'))).toBe(true)
    expect(samePublishedStatus(published, publishedStatusOf(idle, null, 'Sonnet 5.5'))).toBe(false)
    expect(samePublishedStatus(published, publishedStatusOf(idle, null, ''))).toBe(false)
  })

  it('the edge publisher writes a model change alone, and remembers the cloud value across a write that says nothing', async () => {
    const published = new Map<string, PublishedAgentStatus>()
    const writes: (string | null)[] = []
    let model: string | null = 'Opus 5.5'
    let reading: AgentStatusReading = idle
    const run = () => publishAgentStatusTransitions({
      agentUserIds: ['a'],
      published,
      statusOf: () => reading,
      modelNameOf: () => model,
      report: async (_id, next) => { writes.push(next.modelName) },
      shouldBail: () => false,
    })
    await run()
    expect(writes).toEqual(['Opus 5.5'])
    // The host cannot name the model right now (the session stopped): nothing to write, the cloud keeps Opus.
    model = null
    await run()
    expect(writes).toEqual(['Opus 5.5'])
    // A reading change while it says nothing about the model: written, and the memory still holds the cloud's Opus.
    reading = { status: 'working', detail: 'running', running: true, background: null }
    await run()
    expect(writes).toEqual(['Opus 5.5', null])
    expect(published.get('a')?.modelName).toBe('Opus 5.5')
    // Only the model changes: that alone is a publication.
    model = 'Sonnet 5.5'
    await run()
    expect(writes).toEqual(['Opus 5.5', null, 'Sonnet 5.5'])
    // The host knows there is no concrete model to name: '' clears it.
    model = ''
    await run()
    expect(writes).toEqual(['Opus 5.5', null, 'Sonnet 5.5', ''])
    expect(published.get('a')?.modelName).toBe('')
  })

  it('the shared publisher keeps the published model across a write that does not carry one', async () => {
    const published = new Map()
    const publish = createAgentRuntimeStatePublisher({ published, nowMs: () => 0 })
    const writes: (string | null | undefined)[] = []
    const report = async (state: { modelName?: string | null }) => { writes.push(state.modelName) }
    await publish(() => ({ agentUserId: 'a', activityStatus: 'idle', modelName: 'Opus 5.5', runtimeKind: 'gugu', runtimeLabel: 'h' }), report)
    expect(published.get('a')?.modelName).toBe('Opus 5.5')
    // Same reading, no model: nothing changed for the cloud ⇒ no write.
    expect(await publish(() => ({ agentUserId: 'a', activityStatus: 'idle', runtimeKind: 'gugu', runtimeLabel: 'h' }), report)).toBe(false)
    expect(writes).toEqual(['Opus 5.5'])
    expect(published.get('a')?.modelName).toBe('Opus 5.5')
  })
})
