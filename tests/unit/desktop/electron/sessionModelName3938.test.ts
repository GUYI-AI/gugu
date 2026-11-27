// #3938 The model name the agent's card shows, by the settings model list's rule: a concrete model by its name, a
// placeholder by the model it stands for, nothing when it names none; a Gugu model by its catalog name.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  live: new Set<string>(),
  /** What each successive sessionPlatformModel read answers. */
  decisions: [] as Array<{ modelId: string; label?: string } | null | undefined>,
  label: null as string | null,
  options: null as unknown,
  optionsError: null as Error | null,
}))

vi.mock('@main/core/acp/agent-status-bridge', () => ({ acpAgentStatusBridge: { current: () => new Map([...fixture.live].map((id) => [id, {}])) } }))
vi.mock('@main/core/session-timeline/live-options', () => {
  class SessionOptionsError extends Error {
    constructor(readonly code: string, message: string) { super(message) }
  }
  return {
    SessionOptionsError,
    readSessionOptions: async () => {
      if (fixture.optionsError) throw fixture.optionsError
      return fixture.options
    },
  }
})
vi.mock('@main/db/client', () => ({ db: { select: () => ({ from: () => ({ where: async () => [{ provider: 'claude', runtime: 'acp' }] }) }) } }))
vi.mock('../../../../apps/desktop/electron/session/main/core/sessions/platform-model-selection', () => ({
  sessionPlatformModel: async () => fixture.decisions.shift(),
  sessionModelLabel: async () => fixture.label,
}))

const { selectedModelName, sessionModelName } = await import('../../../../apps/desktop/electron/session/main/core/sessions/session-model-name')
const { SessionOptionsError } = await import('@main/core/session-timeline/live-options')

const choice = (id: string, name: string, description?: string) => ({ id, name, ...(description ? { description } : {}) })

describe('#3938 selectedModelName follows the model list rule', () => {
  it('names a concrete model by its own name', () => {
    expect(selectedModelName({ selected: 'opus', available: [choice('opus', 'Opus 5.5'), choice('sonnet', 'Sonnet 5.5')] })).toBe('Opus 5.5')
  })

  it('names a placeholder by the model its description names', () => {
    const group = { selected: 'default', available: [choice('default', 'Default (recommended)', 'Opus 5.5 with 1M context'), choice('sonnet', 'Sonnet 5.5')] }
    expect(selectedModelName(group)).toBe('Opus 5.5')
  })

  it('a placeholder that names no model, or a selection outside the choices, is "" — never "Default"', () => {
    expect(selectedModelName({ selected: 'default', available: [choice('default', 'Default', 'Uses the account default')] })).toBe('')
    expect(selectedModelName({ selected: 'gone', available: [choice('opus', 'Opus 5.5')] })).toBe('')
    expect(selectedModelName({ selected: 'codex-auto-review', available: [choice('codex-auto-review', 'Auto review')] })).toBe('')
  })

  it('nothing selected is nothing known', () => {
    expect(selectedModelName({ selected: null, available: [choice('opus', 'Opus 5.5')] })).toBeNull()
  })
})

describe('#3938 sessionModelName', () => {
  beforeEach(() => {
    fixture.live.clear()
    fixture.decisions = []
    fixture.label = null
    fixture.options = null
    fixture.optionsError = null
  })

  it('a Gugu model: its catalog name; "" once the catalog answered without it; null while it cannot be asked', async () => {
    fixture.decisions = [{ modelId: 'm1' }]
    fixture.label = 'GLM 5'
    expect(await sessionModelName('s1')).toBe('GLM 5')
    fixture.label = null
    fixture.decisions = [{ modelId: 'm1' }, { modelId: 'm1', label: '' }]
    expect(await sessionModelName('s1')).toBe('')
    fixture.decisions = [{ modelId: 'm1' }, { modelId: 'm1' }]
    expect(await sessionModelName('s1')).toBeNull()
  })

  it('the harness own model: read only from a live session, by the selected option', async () => {
    fixture.decisions = [null, null, null]
    fixture.options = { model: { selected: 'opus', available: [choice('opus', 'Opus 5.5')] } }
    expect(await sessionModelName('s1'), 'not held by the runtime').toBeNull()
    fixture.live.add('s1')
    expect(await sessionModelName('s1')).toBe('Opus 5.5')
    fixture.options = { model: null }
    expect(await sessionModelName('s1'), 'no model option reported').toBeNull()
  })

  it('a session that stopped between the check and the read is nothing known; any other failure is loud', async () => {
    fixture.live.add('s1')
    fixture.optionsError = new SessionOptionsError('session_not_live', 'not running')
    expect(await sessionModelName('s1')).toBeNull()
    fixture.optionsError = new Error('runtime exploded')
    await expect(sessionModelName('s1')).rejects.toThrow('runtime exploded')
  })
})
