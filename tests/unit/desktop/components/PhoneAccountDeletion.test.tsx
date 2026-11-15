// @vitest-environment jsdom
import { createAccountClosureLocalCleanup } from '../../../../apps/desktop/src/components/settings/accountDeletion/accountClosureLocalCleanup'
import type { PhoneAccountClosureActions } from '../../../../apps/desktop/src/components/settings/accountDeletion/phoneAccountClosureFlow'
const createPhoneAccountClosureFlow = (actions: Omit<PhoneAccountClosureActions, 'localCleanup' | 'readResult'>) => createFlow({ ...actions, readResult: async () => ({ status: 'processing' }), localCleanup: createAccountClosureLocalCleanup({
  scope: { ownerId: 'owner', localOperationId: 'operation' }, native: { receipt: { put: async () => {}, get: async () => 'opaque-test-proof', remove: async () => {} }, eraseLocal: async () => ({ status: 'complete', retainedUnattributed: [] }) },
  journal: { write: async () => {}, read: async () => null, remove: async () => {} },
}) })
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PhoneAccountDeletion } from '../../../../apps/desktop/src/components/settings/accountDeletion/PhoneAccountDeletion'
import { createPhoneAccountClosureFlow as createFlow, type PhoneCleanupAcknowledgement } from '../../../../apps/desktop/src/components/settings/accountDeletion/phoneAccountClosureFlow'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n'
import { createNode, createReactHarness, clickElement } from '../../../support/testHarness'

const impact = { email: 'example@gugu.test', agents: 6, projects: 3, files: 28, fileBytes: 156000000, groupMessages: 342, remainingCredits: 1280 }
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); setLocalePreference('zh-CN') })
afterEach(() => harness.cleanup())
const confirmation = { stage: 'confirm' as const, impact, confirmation: '注销账号', waived: true, busy: false, onConfirmation: vi.fn(), onWaive: vi.fn() }
const confirm = () => act(async () => { harness.container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })

for (const platform of ['android', 'ios'] as const) describe(`${platform} phone progress`, () => {
  it('shows the ordered progress, halts at the failed step, then manually resumes without reporting early success', async () => {
    let finishStop!: (value: PhoneCleanupAcknowledgement) => void
    const stopAgent = vi.fn(() => new Promise<PhoneCleanupAcknowledgement>(resolve => { finishStop = resolve }))
    const removeDevice = vi.fn(async (): Promise<PhoneCleanupAcknowledgement> => ({ confirmed: false, canRetry: true }))
    const closeAccount = vi.fn(async () => ({ status: 'deleted' as const }))
    const flow = createPhoneAccountClosureFlow({ platform, stopAgent, removeDevice, closeAccount })
    await harness.render(createNode(PhoneAccountDeletion, { confirmation, flow, onCancel: vi.fn(), onReturnToLogin: vi.fn() }))
    await confirm()
    expect(harness.container.querySelector('h2')?.textContent).toBe('正在停止这台手机上的智能体')
    expect(closeAccount).not.toHaveBeenCalled()
    await act(async () => { finishStop({ confirmed: true }); await Promise.resolve() })
    expect(harness.container.querySelector('h2')?.textContent).toBe('未能移除这台手机')
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain('不会继续下一步')
    expect(harness.container.textContent).not.toContain('账号已注销')
    expect(closeAccount).not.toHaveBeenCalled()
    removeDevice.mockResolvedValue({ confirmed: true })
    await clickElement([...harness.container.querySelectorAll('button')].find(button => button.textContent === '重试这一步')!)
    expect(stopAgent).toHaveBeenCalledTimes(1)
    expect(harness.container.querySelector('h2')?.textContent).toBe('账号已注销')
  })

  it('does not render a retry or success after an unknown close result', async () => {
    const flow = createPhoneAccountClosureFlow({ platform, stopAgent: async () => ({ confirmed: true }), removeDevice: async () => ({ confirmed: true }), closeAccount: async () => ({ status: 'processing' }) })
    await harness.render(createNode(PhoneAccountDeletion, { confirmation, flow, onCancel: vi.fn(), onReturnToLogin: vi.fn() }))
    await confirm()
    expect(harness.container.textContent).toContain('注销结果尚未确认')
    expect(harness.container.textContent).not.toContain('账号已注销')
    expect(harness.container.querySelector('button')?.textContent).toBe('查看结果')
  })
})
