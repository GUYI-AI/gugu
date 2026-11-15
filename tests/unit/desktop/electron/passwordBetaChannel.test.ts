import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules() })
describe('password build channel constant', () => {
  it.each(['beta', 'production', 'acceptance-local', '', undefined])('only enables the beta literal: %s', async tier => {
    vi.stubGlobal('__GUGU_TIER__', tier)
    vi.resetModules()
    const { PASSWORD_BETA_ENABLED } = await import('../../../../packages/core/src/shared/passwordBeta')
    expect(PASSWORD_BETA_ENABLED).toBe(tier === 'beta')
  })

  it('cannot enable a production build through environment or later runtime mutations', async () => {
    vi.stubGlobal('__GUGU_TIER__', 'production')
    vi.stubEnv('GUGU_TIER', 'beta')
    vi.resetModules()
    const { PASSWORD_BETA_ENABLED } = await import('../../../../packages/core/src/shared/passwordBeta')
    expect(PASSWORD_BETA_ENABLED).toBe(false)
    vi.stubGlobal('__GUGU_TIER__', 'beta')
    expect(PASSWORD_BETA_ENABLED).toBe(false)
  })
})
