import { afterEach, describe, expect, it, vi } from 'vitest'

// Two host-pushed readings of the task page are replicas now: the tunnel links main keeps (was a module `let` with its
// own listeners) and an agent's task-page context (was a per-mount effect with a subject guard, #3911).
async function fixture(invoke: (name: string, ...args: unknown[]) => Promise<unknown>) {
  vi.resetModules()
  const listeners = new Map<string, (value: unknown) => void>()
  vi.stubGlobal('window', { electronAPI: {
    eventOn: (name: string, cb: (value: unknown) => void) => { listeners.set(name, cb); return () => { listeners.delete(name) } },
    invoke,
  } })
  const replica = await import('@/lib/replica')
  replica.followRendererSession('SIGNED_IN', 'tester')
  return { replica, emit: (name: string, value: unknown) => listeners.get(name)!(value), listening: (name: string) => listeners.has(name) }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('tunnel links', () => {
  it('are not known linked before main answers, then the answer; a pushed state replaces it', async () => {
    let answer: (value: unknown) => void = () => {}
    const { emit } = await fixture((name) => name === 'tunnel-machines:state' ? new Promise((resolve) => { answer = resolve }) : Promise.resolve([]))
    const channel = await import('@/lib/sshLinkChannel')
    const heard: unknown[] = []
    channel.subscribeTunnelState((state) => heard.push(state))
    expect(channel.tunnelLinks.peek().state).toBe('unknown')
    expect(channel.isTunnelLinked('d1')).toBe(false)
    answer({ ready: ['d1'], problems: {} })
    await vi.waitFor(() => expect(channel.isTunnelLinked('d1')).toBe(true))
    // The first read reached the listeners too (device RPC re-picks its pipes on it).
    expect(heard).toEqual([{ ready: ['d1'], problems: {} }])
    emit('tunnel-machines:changed', { ready: [], problems: { d1: 'relayDown' } })
    expect(channel.isTunnelLinked('d1')).toBe(false)
    const reading = channel.tunnelLinks.peek()
    expect(reading.state === 'value' && reading.value.problems).toEqual({ d1: 'relayDown' })
  })
})

describe('an agent\'s task-page context', () => {
  it('is keyed by the agent: another agent is unknown until answered, ❌ the previous agent\'s answer', async () => {
    const contexts: Record<string, unknown> = {
      busy: { projectId: 'p', sessionId: 's-busy', view: 'code', platformRecovery: null, projectionError: null },
    }
    let idleAnswer: (value: unknown) => void = () => {}
    await fixture(async (name, agent) => {
      if (name !== 'sessionpage:agent-context') return null
      if (agent === 'idle') return new Promise((resolve) => { idleAnswer = resolve })
      return contexts[agent as string] ?? null
    })
    const { agentSessionContext } = await import('@/hooks/useSessionpageAgentProjection')
    await agentSessionContext.fetch('busy')
    void agentSessionContext.prefetch('idle')
    expect(agentSessionContext.peek('busy').state).toBe('value')
    expect(agentSessionContext.peek('idle').state).toBe('unknown')
    idleAnswer(null)
    await vi.waitFor(() => expect(agentSessionContext.peek('idle')).toMatchObject({ state: 'value', value: null }))
  })
})
