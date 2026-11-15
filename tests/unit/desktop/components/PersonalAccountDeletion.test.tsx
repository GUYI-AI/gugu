// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PersonalAccountDeletion, PersonalAccountDeletionEntry } from '../../../../apps/desktop/src/components/settings/accountDeletion/PersonalAccountDeletion'
import { accountDeletionConfirmed, type AccountDeletionImpact, type AccountDeletionView } from '../../../../apps/desktop/src/components/settings/accountDeletion/accountDeletionView'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n'
import { clickElement, createNode, createReactHarness } from '../../../support/testHarness'

const impact: AccountDeletionImpact = { email: 'example@gugu.test', agents: 6, projects: 3, files: 28, fileBytes: 156000000, groupMessages: 342, remainingCredits: 1280 }
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); setLocalePreference('zh-CN') })
afterEach(() => harness.cleanup())
const render = (view: AccountDeletionView) => harness.render(createNode(PersonalAccountDeletion, { view, onCancel: vi.fn() }))
const submit = () => act(async () => { harness.container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })

describe('personal account deletion presentation', () => {
  it('requires the exact phrase and an explicit positive-credit waiver', () => {
    expect(accountDeletionConfirmed('注销账号', 1280, false)).toBe(false)
    expect(accountDeletionConfirmed('注销账号 ', 1280, true)).toBe(false)
    expect(accountDeletionConfirmed(' 注销账号', 0, true)).toBe(false)
    expect(accountDeletionConfirmed('注销账号', Number.NaN, true)).toBe(false)
    expect(accountDeletionConfirmed('注销账号', -1, true)).toBe(false)
    expect(accountDeletionConfirmed('注销账号', 1280, true)).toBe(true)
    expect(accountDeletionConfirmed('注销账号', 0, false)).toBe(true)
  })

  it('shows all consequences and retains group history under the deleted identity', async () => {
    await render({ stage: 'impact', impact, acknowledged: false, onAcknowledge: vi.fn(), onContinue: vi.fn() })
    const text = harness.container.textContent!
    for (const label of ['你的智能体', '你的项目', '你的文件', '你发出的消息和文件', '剩余积分', '已注销用户']) expect(text).toContain(label)
    expect([...harness.container.querySelectorAll('button')].find(button => button.textContent === '继续')?.disabled).toBe(true)
    expect(text).not.toMatch(/冷静期|反悔期|群消息将被删除/)
  })

  it('refuses form submission before credit waiver, then permits explicit confirmation', async () => {
    const onDelete = vi.fn()
    const view: AccountDeletionView = { stage: 'confirm', impact, confirmation: '注销账号', waived: false, busy: false, onConfirmation: vi.fn(), onWaive: vi.fn(), onDelete }
    await render(view)
    await submit()
    expect(onDelete).not.toHaveBeenCalled()
    await render({ ...view, waived: true })
    await submit()
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('keeps a pending request separate from a completed deletion', async () => {
    const onDelete = vi.fn()
    await render({ stage: 'confirm', impact, confirmation: '注销账号', waived: true, busy: true, onConfirmation: vi.fn(), onWaive: vi.fn(), onDelete })
    await submit()
    expect(onDelete).not.toHaveBeenCalled()
    expect(harness.container.querySelector('[role="status"]')?.textContent).toBe('正在注销账号…')
    expect(harness.container.querySelector('h2')?.textContent).toBe('确认注销账号？')
  })

  it('does not accept a nonnumeric six-character email code', async () => {
    const onVerify = vi.fn()
    const view: AccountDeletionView = { stage: 'verify', email: impact.email, code: 'abc123', busy: false, onCode: vi.fn(), onVerify, onResend: vi.fn() }
    await render(view)
    await submit()
    expect(onVerify).not.toHaveBeenCalled()
    await render({ ...view, code: '123456' })
    await submit()
    expect(onVerify).toHaveBeenCalledTimes(1)
  })

  it('shows a single actionable blocker without claiming deletion succeeded', async () => {
    const onAction = vi.fn()
    await render({ stage: 'blocked', reason: '有一笔退款正在处理。', items: [{ id: 'refund', label: '退款处理中', actionLabel: '查看退款进度', onAction }], onRetry: vi.fn() })
    expect(harness.container.textContent).toContain('账号尚未注销，数据未受影响。')
    await clickElement([...harness.container.querySelectorAll('button')].find(button => button.textContent === '查看退款进度')!)
    expect(onAction).toHaveBeenCalledTimes(1)
  })

  it('reports an unavailable review without inventing empty account quantities', async () => {
    await render({ stage: 'unavailable', onRetry: vi.fn() })
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toBe('请重试。账号尚未注销，数据未受影响。')
    expect(harness.container.querySelectorAll('.gg-settings-row')).toHaveLength(0)
  })
})

it('only presents the personal account entry when explicitly available', async () => {
  const onOpen = vi.fn()
  for (const flags of [{ available: false, personal: true }, { available: true, personal: false }]) {
    await harness.render(createNode(PersonalAccountDeletionEntry, { ...flags, onOpen }))
    expect(harness.container.textContent).toBe('')
  }
  await harness.render(createNode(PersonalAccountDeletionEntry, { available: true, personal: true, onOpen }))
  expect(harness.container.textContent).toContain('注销你的个人账号。')
  await clickElement(harness.container.querySelector('button')!)
  expect(onOpen).toHaveBeenCalledTimes(1)
})
