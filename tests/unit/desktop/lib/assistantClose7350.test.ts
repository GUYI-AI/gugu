// @vitest-environment jsdom
// #7350 关闭住在这台电脑上的咕咕:撤定时任务 →(勾了)删它开过的会话 → 删它 → 停它的会话 → 清它的家 → 回到「认识咕咕」。
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloseSession } from '../../../../apps/desktop/src/lib/assistantClose'

const mine = vi.hoisted(() => ({ agentId: null as string | null }))
vi.mock('../../../../apps/desktop/src/lib/myAssistant', () => ({
  myAssistant: { peek: () => (mine.agentId === undefined ? { state: 'unknown' } : { state: 'value', value: { agentId: mine.agentId, provisionDeviceId: null }, stale: false, error: null }) },
}))

const {
  AssistantCloseError,
  closeIfMyAssistant,
  closeLocalAssistant,
  planLocalClose,
} = await import('../../../../apps/desktop/src/lib/assistantClose')
const { UI_EVENTS } = await import('../../../../apps/desktop/src/lib/uiEvents')

const GUGU = 'agent-gugu'
const session = (conversationId: string, extra: Record<string, unknown> = {}) =>
  ({ conversationId, projectId: 'p1', title: conversationId, agent: null, parentConversationId: null, spawnedByConversationId: null, ...extra }) as CloseSession

const sessions = [
  session('s-gugu', { agent: { userId: GUGU } }),
  session('s-child', { agent: { userId: 'agent-child' }, spawnedByConversationId: 's-gugu' }),
  session('s-grandchild', { parentConversationId: 's-child' }),
  session('s-other', { agent: { userId: 'agent-other' } }),
]
const automations = [
  { id: 'a-gugu', agentSessionId: 's-gugu' },
  { id: 'a-child', agentSessionId: 's-child' },
  { id: 'a-grandchild', agentSessionId: 's-grandchild' },
  { id: 'a-other', agentSessionId: 's-other' },
  { id: 'a-none' },
]

function rig(overrides: Record<string, unknown> = {}) {
  const calls: string[] = []
  let remaining = [...sessions]
  const deps = {
    listSessions: vi.fn(async () => remaining),
    listAutomations: vi.fn(async () => automations),
    deleteAutomation: vi.fn(async (id: string) => void calls.push(`schedule:${id}`)),
    removeAgent: vi.fn(async (id: string) => {
      calls.push(`agent:${id}`)
      remaining = remaining.filter(session => session.agent?.userId !== id)
    }),
    archiveSession: vi.fn(async (_projectId: string, id: string) => void calls.push(`archive:${id}`)),
    wipeHome: vi.fn(async () => void calls.push('wipe')),
    resetLocalState: vi.fn(() => void calls.push('reset')),
    ...overrides,
  }
  return { calls, deps }
}

afterEach(() => vi.clearAllMocks())

describe('close the assistant that lives on this computer (#7350)', () => {
  it('cloud cleanup unavailable or the target changed: refuse before deleting any schedule, session or identity', async () => {
    const plan = planLocalClose(GUGU, sessions)
    const { calls, deps } = rig({ check: async () => { throw new Error('cloud cleanup is not available') } })
    await expect(closeLocalAssistant({ assistantId: GUGU, deleteStarted: true }, plan, deps)).rejects.toMatchObject({ step: 'check' })
    expect(calls).toEqual([])
  })
  it('knows its own session and every session it started (child, grandchild), nothing else', async () => {
    const plan = planLocalClose(GUGU, sessions)
    expect(plan.own.map((s) => s.conversationId)).toEqual(['s-gugu'])
    expect(plan.started.map((s) => s.conversationId).sort()).toEqual(['s-child', 's-grandchild'])
  })

  it('box unticked: only its own schedules go; started tasks keep their schedules and identities', async () => {
    const { calls, deps } = rig()
    await closeLocalAssistant({ assistantId: GUGU, deleteStarted: false }, planLocalClose(GUGU, await deps.listSessions()), deps)
    expect(calls).toEqual(['schedule:a-gugu', 'archive:s-child', 'archive:s-grandchild', `agent:${GUGU}`, 'wipe', 'reset'])
  })

  it('box ticked: only permanently deleted tasks lose schedules; unbound tasks and their schedules stay recoverable', async () => {
    const { calls, deps } = rig()
    await closeLocalAssistant({ assistantId: GUGU, deleteStarted: true }, planLocalClose(GUGU, await deps.listSessions()), deps)
    expect(calls.slice(0, 2).sort()).toEqual(['schedule:a-child', 'schedule:a-gugu'])
    expect(calls).not.toContain('schedule:a-other')
    expect(calls).not.toContain('schedule:a-grandchild')
    expect(calls).toContain('agent:agent-child')
    expect(calls).not.toContain('agent:agent-other')
    expect(calls.indexOf('archive:s-grandchild')).toBeLessThan(calls.indexOf(`agent:${GUGU}`))
    expect(calls).not.toContain('archive:s-child')
    expect(calls.slice(-3)).toEqual([`agent:${GUGU}`, 'wipe', 'reset'])
  })

  it('archives its remaining unbound task after identity deletion without archiving a deleted bound task', async () => {
    const unbound = session('s-own-unbound', { agent: { userId: GUGU } })
    const { calls, deps } = rig({
      listSessions: vi.fn().mockResolvedValueOnce([...sessions, unbound]).mockResolvedValueOnce([unbound, sessions[3]]),
    })
    await closeLocalAssistant({ assistantId: GUGU, deleteStarted: true }, planLocalClose(GUGU, await deps.listSessions()), deps)
    expect(calls).not.toContain('archive:s-gugu')
    expect(calls.slice(-4)).toEqual([`agent:${GUGU}`, 'archive:s-own-unbound', 'wipe', 'reset'])
  })

  it('a schedule that is just starting stops everything before anything is deleted (say "wait a moment")', async () => {
    const { calls, deps } = rig({ deleteAutomation: vi.fn(async () => { throw new Error('automation_runs_active') }) })
    const error = await closeLocalAssistant({ assistantId: GUGU, deleteStarted: true }, planLocalClose(GUGU, await deps.listSessions()), deps).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AssistantCloseError)
    expect(error).toMatchObject({ step: 'schedules', kind: 'schedule-starting' })
    expect(calls).toEqual([])
  })

  it('deleting it fails: it is still here, so its session keeps running, its home stays and nothing is reset', async () => {
    const { calls, deps } = rig({ removeAgent: vi.fn(async () => { throw new Error('rpc down') }) })
    const error = await closeLocalAssistant({ assistantId: GUGU, deleteStarted: false }, planLocalClose(GUGU, await deps.listSessions()), deps).catch((e: unknown) => e)
    expect(error).toMatchObject({ step: 'identity', kind: 'failed' })
    expect(calls).toEqual(['schedule:a-gugu', 'archive:s-child', 'archive:s-grandchild'])
  })

  it('it is deleted but its home could not be cleared: say so, and still reset this computer back to "meet Gugu"', async () => {
    const { calls, deps } = rig({ wipeHome: vi.fn(async () => { throw new Error('EBUSY') }) })
    const error = await closeLocalAssistant({ assistantId: GUGU, deleteStarted: false }, planLocalClose(GUGU, await deps.listSessions()), deps).catch((e: unknown) => e)
    expect(error).toMatchObject({ step: 'home', kind: 'failed' })
    expect(calls).toEqual(['schedule:a-gugu', 'archive:s-child', 'archive:s-grandchild', `agent:${GUGU}`, 'reset'])
  })

  it('deleting it from contacts / agent settings opens this close instead of the generic delete, only when it really is the assistant', () => {
    const heard = vi.fn()
    window.addEventListener(UI_EVENTS.closeAssistant, heard)
    try {
      mine.agentId = GUGU
      expect(closeIfMyAssistant('owner-1', 'agent-other')).toBe(false)
      expect(heard).not.toHaveBeenCalled()
      expect(closeIfMyAssistant('owner-1', GUGU)).toBe(true)
      expect(heard).toHaveBeenCalledTimes(1)
      // Not read yet: not known to be the assistant, the general delete runs (a one-moment decision).
      mine.agentId = undefined as never
      expect(closeIfMyAssistant('owner-1', GUGU)).toBe(false)
      expect(heard).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener(UI_EVENTS.closeAssistant, heard)
    }
  })
})
