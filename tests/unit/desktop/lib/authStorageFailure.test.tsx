import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { authStorageRecoveryAction } from '../../../../apps/desktop/src/lib/authStorageFailure'
import { AuthStorageRecovery } from '../../../../apps/desktop/src/components/AuthStorageRecovery'

describe('native auth storage failure presentation', () => {
  it.each([
    ['auth_storage_recovery_required', '请联系支持恢复登录'],
    ['auth_storage_unavailable', '请重启应用后重试'],
  ])('shows one actionable next step for %s without leaking native diagnostics', (code, action) => {
    const error = Object.assign(new Error('PRIVATE_CANARY key_missing /data/user/0'), { code })
    expect(authStorageRecoveryAction(error)).toBe(action)
    const html = renderToStaticMarkup(<AuthStorageRecovery action={authStorageRecoveryAction(error)!} />)
    expect(html).toContain('role="alert"')
    expect(html).toContain(action)
    expect(html).not.toMatch(/PRIVATE_CANARY|key_missing|\/data\/user|input|form|button/)
  })
  it('keeps unrelated auth and transport errors on their existing paths', () => {
    for (const error of [null, 'failure', new Error('offline'), { code: 'session_expired' }]) expect(authStorageRecoveryAction(error)).toBeNull()
  })
})
