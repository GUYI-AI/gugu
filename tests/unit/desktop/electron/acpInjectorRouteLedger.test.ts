// A Chat UI start that stays on the engine's own model is recorded in the per-start route ledger, like a platform start.
// 2026-11-10 gpu A/B: a codex assistant created on its own model left no row, so switching it to a Gugu model was read
// as "route unchanged" and resumed the openai thread codex then refused (modelProviderMismatch).
import { describe, expect, it, vi } from 'vitest'

const recordModelSource = vi.fn()
vi.mock('../../../../apps/desktop/electron/session/main/core/usage/model-source-recorder', () => ({
  recordModelSource: (...args: unknown[]) => recordModelSource(...args),
}))

const { createSessionpagePlatformHooks } = await import('../../../../apps/desktop/electron/sessionpage/sessionpage-platform-hooks')

describe('acpInjector route ledger', () => {
  it('records an own-model Chat UI start as byok, with or without a per-session choice', async () => {
    const hooks = createSessionpagePlatformHooks({ authProvider: () => null, provisionDeps: {} as never, env: process.env })
    for (const platformModel of [undefined, null]) {
      await expect(hooks.acpInjector({ sessionId: 'conv-1', projectId: 'p', providerId: 'codex', cwd: '/work', platformModel })).resolves.toBeNull()
    }
    expect(recordModelSource.mock.calls).toEqual([['conv-1', 'byok'], ['conv-1', 'byok']])
  })
})
