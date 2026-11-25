import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { authStorageRecoveryAction } from '../../../../apps/desktop/src/lib/authStorageFailure'
import { AuthStorageRecovery } from '../../../../apps/desktop/src/components/AuthStorageRecovery'
import chinese from '../../../../apps/desktop/src/i18n/locales/zh-CN/main'
import english from '../../../../apps/desktop/src/i18n/locales/en-US/main'

describe('native auth storage failure presentation', () => {
  it.each([
    ['zh-CN', 'auth_storage_recovery_required', 'shell.authStorage.contactSupport', '请联系支持恢复登录'],
    ['zh-CN', 'auth_storage_unavailable', 'shell.authStorage.restart', '请重启应用后重试'],
    ['en-US', 'auth_storage_recovery_required', 'shell.authStorage.contactSupport', 'Contact support to recover your login'],
    ['en-US', 'auth_storage_unavailable', 'shell.authStorage.restart', 'Restart the app and try again'],
  ])('shows one localized action for %s %s without leaking native diagnostics', async (language, code, key, copy) => {
    const error = Object.assign(new Error('PRIVATE_CANARY key_missing /data/user/0'), { code })
    const action = authStorageRecoveryAction(error)
    expect(action).toBe(key)
    const i18n = createInstance()
    await i18n.init({ lng: language, resources: { 'zh-CN': { main: chinese }, 'en-US': { main: english } } })
    const html = renderToStaticMarkup(<I18nextProvider i18n={i18n}><AuthStorageRecovery action={action!} /></I18nextProvider>)
    expect(html).toContain('role="alert"')
    expect(html).toContain(copy)
    expect(html).not.toMatch(/PRIVATE_CANARY|key_missing|\/data\/user|input|form|button/)
  })
  it('keeps unrelated auth and transport errors on their existing paths', () => {
    for (const error of [null, 'failure', new Error('offline'), { code: 'session_expired' }]) expect(authStorageRecoveryAction(error)).toBeNull()
  })
})
