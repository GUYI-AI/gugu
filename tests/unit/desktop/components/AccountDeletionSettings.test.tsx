// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { notifyManager as readModelNotify } from '@tanstack/react-query'
import type { AccountClosureV2FlowState } from '../../../../apps/desktop/src/platform/accountClosureV2Flow'
import type { AccountClosureV2Snapshot } from '../../../../apps/desktop/src/platform/accountClosureV2'
import type { SpendingSnapshot } from '../../../../apps/desktop/src/lib/billing/useSpendingPower'
import { clickElement, createNode, createReactHarness } from '../../../support/testHarness'
import { followRendererSession, queryClient } from '../../../../apps/desktop/src/lib/replica'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n'

const f = vi.hoisted(() => {
  const state = { owner: 'A', current: null as unknown as AccountClosureV2FlowState }
  const listeners = new Set<() => void>()
  return {
    state, listeners, spending: { current: null as unknown as SpendingSnapshot }, spendingUsers: [] as unknown[],
    controller: {
      getSnapshot: () => state.current,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      refresh: vi.fn(), sendCode: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), recoverOriginal: vi.fn(),
    },
  }
})
vi.mock('../../../../apps/desktop/src/components/settings/accountDeletion/accountClosureV2Runtime', () => ({ accountClosureV2Controller: () => f.controller }))
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../apps/desktop/src/lib/sessionPublication')>(),
  getRendererSession: () => ({ user: { id: f.state.owner } }),
}))
vi.mock('../../../../apps/desktop/src/lib/billing/useSpendingPower', () => ({
  useSpendingPower: (user: unknown) => { f.spendingUsers.push(user); return user ? f.spending.current : { state: 'unknown', balance: null } },
}))
import { AccountDeletionSettings } from '../../../../apps/desktop/src/components/settings/accountDeletion/AccountDeletionSettings'

let harness: ReturnType<typeof createReactHarness>
const operation = (patch: Partial<AccountClosureV2Snapshot> = {}): AccountClosureV2Snapshot => ({
  handle: { localOperationId: 'local-A', nativeGeneration: '11111111-1111-4111-8111-111111111111', localRevision: 3 },
  ownerId: 'A', phase: 'confirming', serverOperation: { operationId: '22222222-2222-4222-8222-222222222222',
    state: 'open', operationRevision: 2, challengeGeneration: 1 },
  serverPreparationGeneration: '33333333-3333-4333-8333-333333333333', recoveryOnly: true,
  pendingEffect: 'confirm', agentsPaused: true, retainedUnattributed: [], ...patch,
})
const policy = (available: boolean) => ({ status: 'known' as const, value: { protocol_version: 2 as const, available, deletion: 'immediate' as const,
  credit_treatment: 'forfeit_remaining' as const, consent_version: 'immediate-forfeit-v1' as const, device_preparation_required: true as const } })
const balance = (value: SpendingSnapshot['balance'], state: SpendingSnapshot['state'] = 'value') => ({ state, balance: value } as SpendingSnapshot)
const emit = () => { f.state.current = { ...f.state.current }; for (const listener of [...f.listeners]) listener() }
beforeEach(() => {
  readModelNotify.setScheduler((callback) => { callback() })
  queryClient.clear(); harness = createReactHarness(); setLocalePreference('zh-CN'); f.state.owner = 'A'
  followRendererSession('SIGNED_IN', 'A')
  f.state.current = { policy: policy(false), operation: null, busy: false, error: null }
  for (const method of [f.controller.refresh, f.controller.sendCode, f.controller.confirm, f.controller.cancel, f.controller.recoverOriginal]) method.mockReset().mockResolvedValue(undefined)
  f.spending.current = balance(20); f.spendingUsers.length = 0; f.listeners.clear()
})
afterEach(() => harness.cleanup())
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const render = async () => { await harness.render(createNode(AccountDeletionSettings, { ownerId: f.state.owner })); await settle() }
const entry = () => harness.container.querySelector<HTMLButtonElement>('button')
const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]')!
const button = (label: string) => [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === label)!
const submit = () => dialog().querySelector<HTMLButtonElement>('button[type="submit"]')!
const open = async () => { await render(); await clickElement(entry()!); await settle() }
const balanceRead = () => f.spendingUsers.some(user => user !== null)

describe('admission is the native policy read for this account', () => {
  it('keeps a closed fresh admission hidden without a native original operation', async () => {
    await render()
    expect(f.controller.refresh).toHaveBeenCalledOnce()
    expect(entry()).toBeNull()
    expect(f.controller.sendCode).not.toHaveBeenCalled(); expect(balanceRead()).toBe(false)
  })
  it('shows an open admission, reads it again on opening, and states the shared balance (unknown is never zero)', async () => {
    f.state.current.policy = policy(true); f.spending.current = balance(null, 'unknown')
    await open()
    expect(f.controller.refresh).toHaveBeenCalledTimes(2)
    expect(dialog().textContent).toContain('正在读取剩余积分…')
    expect(dialog().textContent).not.toContain('放弃剩余')
    expect(button('发送验证码').disabled).toBe(true)
    f.spending.current = balance(20)
    await harness.render(createNode(AccountDeletionSettings, { ownerId: 'A' })); await settle()
    expect(dialog().textContent).toContain('放弃剩余 20 积分')
    expect(button('发送验证码').disabled).toBe(false)
  })
  it('a balance that cannot be read blocks sending the code and says so', async () => {
    f.state.current.policy = policy(true); f.spending.current = balance(null, 'error')
    await open()
    expect(dialog().textContent).toContain('操作失败，请稍后重试')
    expect(dialog().textContent).not.toContain('放弃剩余')
    expect(button('发送验证码').disabled).toBe(true)
    await clickElement(button('发送验证码'))
    expect(f.controller.sendCode).not.toHaveBeenCalled()
  })
  it('reads only after the running native command settles', async () => {
    f.state.current = { ...f.state.current, policy: policy(true), busy: true }
    await render()
    expect(f.controller.refresh).not.toHaveBeenCalled(); expect(entry()).toBeNull()
    f.state.current.busy = false; await act(async () => { emit() }); await settle()
    expect(f.controller.refresh).toHaveBeenCalledOnce(); expect(entry()).not.toBeNull()
  })
  it('an answer that lands after the renderer changed to B is not A admission', async () => {
    f.state.current.policy = policy(true)
    f.controller.refresh.mockImplementation(async () => { f.state.owner = 'B' })
    await render()
    expect(f.controller.refresh).toHaveBeenCalledOnce(); expect(entry()).toBeNull()
  })
})

describe('existing native account closure remains recoverable after admission closes', () => {
  it('opens the original unknown confirmation and uses one explicit cancellation without a balance read', async () => {
    f.state.current.operation = operation()
    await open()
    expect(dialog()).not.toBeNull(); expect(button('取消').disabled).toBe(false)
    await clickElement(button('取消'))
    expect(f.controller.cancel).toHaveBeenCalledOnce()
    expect(f.controller.sendCode).not.toHaveBeenCalled(); expect(f.controller.confirm).not.toHaveBeenCalled()
    // A resolved command alone is not a native cancelled snapshot.
    expect(dialog()).not.toBeNull()
    expect(balanceRead()).toBe(false)
  })
  it('keeps only safe cancellation when policy reading fails for an existing known operation', async () => {
    f.state.current.policy = { status: 'failed', code: 'unauthorized' }
    f.state.current.operation = operation({ phase: 'prepared', recoveryOnly: false, pendingEffect: null })
    await open()
    expect(button('取消').disabled).toBe(false)
    expect(submit().disabled).toBe(true)
    expect(balanceRead()).toBe(false)
    expect(f.controller.sendCode).not.toHaveBeenCalled(); expect(f.controller.confirm).not.toHaveBeenCalled()
  })
  it('does not expose A recovery as a pending action owned by current B', async () => {
    f.state.owner = 'B'; followRendererSession('SIGNED_IN', 'B'); f.state.current.operation = operation()
    await render()
    expect(entry()).toBeNull()
    expect(f.controller.cancel).not.toHaveBeenCalled()
  })
  it('keeps request-active cancellation blocked and reads the original result on user request', async () => {
    f.state.current.operation = operation({ confirmCancellationBlocked: true })
    await open()
    expect(button('取消').disabled).toBe(true)
    await clickElement(submit())
    expect(f.controller.recoverOriginal).toHaveBeenCalledOnce()
    expect(f.controller.cancel).not.toHaveBeenCalled(); expect(f.controller.confirm).not.toHaveBeenCalled()
    expect(balanceRead()).toBe(false)
  })
})
