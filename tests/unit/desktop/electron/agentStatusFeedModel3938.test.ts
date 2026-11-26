// #3938 The per-agent feed carries the bound session's model name: read when the agent binds and whenever the session
// says its model may have changed; one read at a time, a later read supersedes, a read that knows nothing keeps the last.
import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusChange } from '../../../../apps/desktop/src/session/shared/core/sessions/sessionEvents'

vi.mock('../../../../apps/desktop/electron/sessionpage/emdash-agent-provisioning', () => ({ onSessionpageAgentProvisioned: () => () => {} }))
vi.mock('../../../../apps/desktop/electron/sessionpage/sessionpage-session-agent', () => ({ guguAgentUserIdForSession: async (sessionId: string) => `agent-of-${sessionId}` }))

const { AgentStatusFeed } = await import('../../../../apps/desktop/electron/sessionpage/agent-status-feed')

const change = (sessionId: string): AgentStatusChange => ({
  sessionId, projectId: 'p', reading: { status: 'idle', detail: null } as never, unseen: false,
  reviewGate: null, providerBlocker: null, statusSourceFault: null,
})

function harness() {
  const answers: Array<{ sessionId: string; resolve: (name: string | null) => void }> = []
  let statusCb: (c: AgentStatusChange) => void = () => {}
  let modelCb: (sessionId: string) => void = () => {}
  const feed = new AgentStatusFeed()
  feed.attach({
    onAgentStatus: (cb) => { statusCb = cb; return () => {} },
    agentStatusSnapshot: async () => [],
    onSessionsGone: () => () => {},
    onSessionLifeView: () => () => {},
    sessionLifeStatusOf: () => null,
    sessionModelName: (sessionId) => new Promise((resolve) => answers.push({ sessionId, resolve })),
    onSessionModelChanged: (cb) => { modelCb = cb; return () => {} },
  }, { env: {} })
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  return { feed, answers, flush, status: (id: string) => statusCb(change(id)), modelChanged: (id: string) => modelCb(id) }
}

describe('#3938 agent status feed model name', () => {
  it('binding reads the model; the entry carries it once it answers', async () => {
    const h = harness()
    h.status('s1')
    await h.flush()
    expect(h.feed.get('agent-of-s1')?.modelName).toBeNull()
    expect(h.answers.map((a) => a.sessionId)).toEqual(['s1'])
    h.answers[0]!.resolve('Opus 5.5')
    await h.flush()
    expect(h.feed.get('agent-of-s1')?.modelName).toBe('Opus 5.5')
  })

  it('a model change re-reads; a read that knows nothing (null) keeps the last name', async () => {
    const h = harness()
    h.status('s1')
    await h.flush()
    h.answers[0]!.resolve('Opus 5.5')
    await h.flush()
    h.modelChanged('s1')
    await h.flush()
    h.answers[1]!.resolve(null)
    await h.flush()
    expect(h.feed.get('agent-of-s1')?.modelName).toBe('Opus 5.5')
    h.modelChanged('s1')
    await h.flush()
    h.answers[2]!.resolve('')
    await h.flush()
    expect(h.feed.get('agent-of-s1')?.modelName, 'it names no concrete model').toBe('')
  })

  it('reads go one at a time, and a read superseded before its turn never runs', async () => {
    const h = harness()
    h.status('s1')
    await h.flush()
    h.modelChanged('s1')
    h.modelChanged('s1')
    await h.flush()
    expect(h.answers.length, 'the first read is still out').toBe(1)
    h.answers[0]!.resolve('Opus 5.5')
    await h.flush()
    expect(h.answers.length, 'of the two queued reads only the newest runs').toBe(2)
    h.answers[1]!.resolve('Sonnet 5.5')
    await h.flush()
    expect(h.feed.get('agent-of-s1')?.modelName).toBe('Sonnet 5.5')
  })

  it('a model change of a session no agent is bound to reads nothing', async () => {
    const h = harness()
    h.modelChanged('unbound')
    await h.flush()
    expect(h.answers).toEqual([])
  })
})
