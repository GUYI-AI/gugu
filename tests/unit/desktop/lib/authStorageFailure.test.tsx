// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { authStorageRecoveryAction } from '../../../../apps/desktop/src/lib/authStorageFailure'
import { AuthStorageRecovery } from '../../../../apps/desktop/src/components/AuthStorageRecovery'
import chinese from '../../../../apps/desktop/src/i18n/locales/zh-CN/main'
import english from '../../../../apps/desktop/src/i18n/locales/en-US/main'
import { nativeAuthRecoveryState } from '../../../../apps/desktop/src/lib/nativeAuthRecoveryState'
// React DOM interaction tests use the same explicit act boundary as the existing suite.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const recovery = vi.hoisted(() => ({
  inspect: vi.fn(async () => ({ canReset: true, revision: 'a'.repeat(64) })),
  retry: vi.fn(async () => {}), reset: vi.fn(async () => {}),
}))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ mainAuthSessionStorage: { recoveryState: recovery.inspect } }))
vi.mock('../../../../apps/desktop/src/lib/sessionCoordinator', () => ({ sessionCoordinator: { retryAuthStorage: recovery.retry, resetUnreadableAuthStorage: recovery.reset } }))
let root: Root | null = null
let host: HTMLDivElement
const button = (name: string) => [...host.querySelectorAll('button')].find(node => node.textContent === name) ?? null
const click = (node: HTMLButtonElement) => act(async () => { node.click() })
const waitFor = vi.waitFor
const alert = () => host.querySelector('[role="alert"]')!
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); await nativeAuthRecoveryState.reset(); vi.clearAllMocks() })
async function show(code: string, language = 'zh-CN') {
  const action = authStorageRecoveryAction({ code })!
  const i18n = createInstance()
  await i18n.init({ lng: language, resources: { 'zh-CN': { main: chinese }, 'en-US': { main: english } } })
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => root!.render(<I18nextProvider i18n={i18n}><AuthStorageRecovery action={action} /></I18nextProvider>))
  return host
}
describe('native auth storage recovery actions', () => {
  it.each([
    ['zh-CN', 'auth_storage_recovery_required', '登录信息无法读取，需要重新登录。', '重新登录'],
    ['zh-CN', 'auth_storage_unavailable', '暂时无法读取登录信息，请重试。', '重试'],
    ['en-US', 'auth_storage_recovery_required', 'Your login information cannot be read. Please sign in again.', 'Sign in again'],
    ['en-US', 'auth_storage_unavailable', 'Your login information is temporarily unavailable. Please try again.', 'Retry'],
  ])('shows a real localized action for %s %s', async (language, code, copy, label) => {
    const view = await show(code, language)
    expect(alert().textContent).toBe(copy)
    await waitFor(() => expect(button(label)!.disabled).toBe(false))
    expect(view.innerHTML).not.toMatch(/key_missing|\/data\/user|PRIVATE_CANARY/)
    expect(recovery.reset).not.toHaveBeenCalled()
  })
  it('manual retry executes once while in flight', async () => {
    let finish!: () => void
    recovery.retry.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    await show('auth_storage_unavailable')
    const control = button('重试')!
    await click(control); await click(control)
    expect(recovery.retry).toHaveBeenCalledOnce(); expect(control.disabled).toBe(true)
    finish(); await waitFor(() => expect(control.disabled).toBe(false))
    expect(recovery.reset).not.toHaveBeenCalled()
  })
  it('preserves closure custody and offers retry without destructive reset', async () => {
    recovery.inspect.mockResolvedValueOnce({ canReset: false, revision: 'a'.repeat(64) })
    await show('auth_storage_recovery_required')
    await waitFor(() => expect(button('重新登录')).toBeNull())
    await click(button('重试')!)
    expect(recovery.retry).toHaveBeenCalledOnce(); expect(recovery.reset).not.toHaveBeenCalled()
  })
  it('sends the observed revision only on explicit user action and stays blocked on native refusal', async () => {
    recovery.reset.mockRejectedValueOnce({ code: 'auth_storage_closure_pending', message: 'PRIVATE_CANARY' })
    await show('auth_storage_recovery_required')
    const control = button('重新登录')!
    await waitFor(() => expect(control.disabled).toBe(false)); await click(control)
    await waitFor(() => expect(recovery.reset).toHaveBeenCalledWith('a'.repeat(64)))
    await waitFor(() => expect(alert().textContent).toContain('账号是否已注销'))
    expect(host.textContent).not.toContain('PRIVATE_CANARY')
  })
  it('keeps unrelated errors on their existing paths', () => {
    for (const error of [null, 'failure', new Error('offline'), { code: 'session_expired' }]) expect(authStorageRecoveryAction(error)).toBeNull()
  })
})
