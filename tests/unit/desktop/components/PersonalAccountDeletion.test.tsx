// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PersonalAccountDeletion, PersonalAccountDeletionEntry } from '../../../../apps/desktop/src/components/settings/accountDeletion/PersonalAccountDeletion'
import { accountDeletionCanSubmit, type AccountDeletionView } from '../../../../apps/desktop/src/components/settings/accountDeletion/accountDeletionView'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n'
import { clickElement, createNode, createReactHarness } from '../../../support/testHarness'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); setLocalePreference('zh-CN') })
afterEach(() => harness.cleanup())
const view = (patch: Partial<AccountDeletionView> = {}): AccountDeletionView => ({
  phase: 'ready', remainingCredits: 1280, code: '123456', codeSent: true, waived: false,
  onCode: vi.fn(), onWaive: vi.fn(), onResend: vi.fn(), onDelete: vi.fn(), onCheckResult: vi.fn(), onRetryLocal: vi.fn(), ...patch,
})
const render = (state: AccountDeletionView) => harness.render(createNode(PersonalAccountDeletion, { view: state, onCancel: vi.fn() }))
const dialog = () => document.body.querySelector('[role="dialog"]')!
const submit = () => act(async () => { dialog().querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })

describe('approved compact account closure dialog', () => {
  it('uses the existing Cancel button for explicit unknown-confirm cancellation and honors the native fence', async () => {
    const onCancel = vi.fn(), state = view({ phase: 'unconfirmed', canCancel: true })
    await harness.render(createNode(PersonalAccountDeletion, { view: state, onCancel }))
    await clickElement([...dialog().querySelectorAll('button')].find(button => button.textContent === '取消')!)
    expect(onCancel).toHaveBeenCalledOnce()
    await harness.render(createNode(PersonalAccountDeletion, { view: { ...state, canCancel: false }, onCancel }))
    expect([...dialog().querySelectorAll('button')].find(button => button.textContent === '取消')?.disabled).toBe(true)
    expect(state.onDelete).not.toHaveBeenCalled()
  })
  it('hides the entry while admission is closed or the account is not personal', async () => {
    const onOpen = vi.fn()
    await harness.render(createNode(PersonalAccountDeletionEntry, { available: false, personal: true, onOpen }))
    expect(harness.container.textContent).toBe('')
    await harness.render(createNode(PersonalAccountDeletionEntry, { available: true, personal: false, onOpen }))
    expect(harness.container.textContent).toBe('')
    expect(onOpen).not.toHaveBeenCalled()
    await harness.render(createNode(PersonalAccountDeletionEntry, { available: true, personal: true, onOpen }))
    await clickElement(harness.container.querySelector('button')!)
    expect(onOpen).toHaveBeenCalledOnce()
  })
  it('dims the Settings page behind it like the other dialogs opened from Settings', async () => {
    await render(view())
    const backdrop = [...document.body.querySelectorAll('.gg-sheet-backdrop')].at(-1)
    expect(backdrop?.getAttribute('style')).toContain('var(--bg-overlay-modal)')
  })
  it('shows the two effects, one credit waiver and one code field in a single dialog', async () => {
    await render(view())
    const text = dialog().textContent!
    expect(text).toContain('智能体、项目和文件会删除')
    expect(text).toContain('发过的消息保留，显示为「已注销用户」')
    expect(text).toContain('放弃剩余 1,280 积分')
    expect(dialog().querySelectorAll('input')).toHaveLength(2)
    expect(text).not.toContain('输入「注销账号」')
    expect(text).not.toContain('注销账号后会发生什么')
  })
  it('shows no waiver for a confirmed zero balance and never treats an unread balance as zero', async () => {
    await render(view({ remainingCredits: 0 }))
    expect(dialog().querySelector('input[type="checkbox"]')).toBeNull()
    expect(accountDeletionCanSubmit(view({ remainingCredits: 0 }))).toBe(true)
    await render(view({ phase: 'loading', remainingCredits: null }))
    expect(dialog().querySelector('input[type="checkbox"]')).toBeNull()
    expect(dialog().querySelector('[role="status"]')?.textContent).toBe('正在读取剩余积分…')
    expect(accountDeletionCanSubmit(view({ remainingCredits: null }))).toBe(false)
  })
  it('requires explicit credit forfeiture and a sent six-digit code, with no typed phrase', async () => {
    const state = view()
    await render(state); await submit()
    expect(state.onDelete).not.toHaveBeenCalled()
    await render({ ...state, waived: true }); await submit()
    expect(state.onDelete).toHaveBeenCalledTimes(1)
    for (const patch of [{ code: 'abc123' }, { code: '' }, { codeSent: false }, { remainingCredits: Number.NaN }, { remainingCredits: -1 }]) {
      expect(accountDeletionCanSubmit(view({ waived: true, ...patch }))).toBe(false)
    }
  })
  it('keeps final submission disabled while native work is in progress', async () => {
    const state = view({ phase: 'confirming', waived: true })
    await render(state); await submit()
    expect(state.onDelete).not.toHaveBeenCalled()
    expect([...dialog().querySelectorAll('button')].find(b => b.textContent === '取消')?.disabled).toBe(true)
    expect(dialog().querySelector('[role="status"]')?.textContent).toBe('正在注销账号…')
  })
  it('checks the original unknown result rather than submitting account closure again', async () => {
    const state = view({ phase: 'unconfirmed' })
    await render(state); await submit()
    expect(state.onCheckResult).toHaveBeenCalledOnce()
    expect(state.onDelete).not.toHaveBeenCalled()
    expect(dialog().textContent).not.toContain('账号已注销')
  })
  it('continues pending local cleanup in the same dialog without another deletion', async () => {
    const state = view({ phase: 'local-pending' })
    await render(state)
    await clickElement([...dialog().querySelectorAll('button')].find(b => b.textContent === '继续清理本机')!)
    expect(state.onRetryLocal).toHaveBeenCalledOnce()
    expect(state.onDelete).not.toHaveBeenCalled()
  })
})
