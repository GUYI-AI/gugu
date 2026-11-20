// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountClosureV2FlowState } from '../../../../apps/desktop/src/platform/accountClosureV2Flow'
import type { AccountClosureV2Snapshot } from '../../../../apps/desktop/src/platform/accountClosureV2'
import { clickElement, createNode, createReactHarness } from '../../../support/testHarness'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n'

const f = vi.hoisted(() => {
  const state = { owner: 'A', current: null as unknown as AccountClosureV2FlowState }
  return { state, balance: vi.fn(), controller: {
    getSnapshot: () => state.current, subscribe: () => () => {}, refresh: vi.fn(),
    sendCode: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), recoverOriginal: vi.fn(),
  } }
})
vi.mock('../../../../apps/desktop/src/components/settings/accountDeletion/accountClosureV2Runtime', () => ({ accountClosureV2Controller: () => f.controller }))
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', () => ({ getRendererSession: () => ({ user: { id: f.state.owner } }) }))
vi.mock('../../../../apps/desktop/src/lib/billing/balance', () => ({ getCreditsBalance: f.balance }))
import { AccountDeletionSettings } from '../../../../apps/desktop/src/components/settings/accountDeletion/AccountDeletionSettings'

let harness: ReturnType<typeof createReactHarness>
const operation = (patch: Partial<AccountClosureV2Snapshot> = {}): AccountClosureV2Snapshot => ({
  handle: { localOperationId: 'local-A', nativeGeneration: '11111111-1111-4111-8111-111111111111', localRevision: 3 },
  ownerId: 'A', phase: 'confirming', serverOperation: { operationId: '22222222-2222-4222-8222-222222222222',
    state: 'open', operationRevision: 2, challengeGeneration: 1 },
  serverPreparationGeneration: '33333333-3333-4333-8333-333333333333', recoveryOnly: true,
  pendingEffect: 'confirm', agentsPaused: true, retainedUnattributed: [], ...patch,
})
beforeEach(() => {
  harness = createReactHarness(); setLocalePreference('zh-CN'); f.state.owner = 'A'
  f.state.current = { policy: { status: 'known', value: { protocol_version: 2, available: false, deletion: 'immediate',
    credit_treatment: 'forfeit_remaining', consent_version: 'immediate-forfeit-v1', device_preparation_required: true } },
    operation: null, busy: false, error: null }
  for (const method of [f.controller.refresh, f.controller.sendCode, f.controller.confirm, f.controller.cancel, f.controller.recoverOriginal]) method.mockReset().mockResolvedValue(undefined)
  f.balance.mockReset().mockResolvedValue(20)
})
afterEach(() => harness.cleanup())
const render = () => harness.render(createNode(AccountDeletionSettings, { ownerId: f.state.owner }))
const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]')!
const cancel = () => [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '取消')!
const open = async () => { await render(); await clickElement(harness.container.querySelector<HTMLButtonElement>('button')!) }

describe('existing native account closure remains recoverable after admission closes', () => {
  it('keeps a closed fresh admission hidden without a native original operation', async () => {
    await render()
    expect(harness.container.querySelector('button')).toBeNull()
    expect(f.controller.sendCode).not.toHaveBeenCalled(); expect(f.balance).not.toHaveBeenCalled()
  })
  it('opens the original unknown confirmation and uses one explicit cancellation without a new balance read', async () => {
    f.state.current.operation = operation()
    await open()
    expect(dialog()).not.toBeNull(); expect(cancel().disabled).toBe(false)
    expect(f.balance).not.toHaveBeenCalled()
    await clickElement(cancel())
    expect(f.controller.cancel).toHaveBeenCalledOnce()
    expect(f.controller.sendCode).not.toHaveBeenCalled(); expect(f.controller.confirm).not.toHaveBeenCalled()
    // A resolved command alone is not a native cancelled snapshot.
    expect(dialog()).not.toBeNull()
  })
  it('keeps only safe cancellation when policy reading fails for an existing known operation', async () => {
    f.state.current.policy = { status: 'failed', code: 'unauthorized' }
    f.state.current.operation = operation({ phase: 'prepared', recoveryOnly: false, pendingEffect: null })
    await open()
    expect(cancel().disabled).toBe(false)
    expect(dialog().querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
    expect(f.balance).not.toHaveBeenCalled()
    expect(f.controller.sendCode).not.toHaveBeenCalled(); expect(f.controller.confirm).not.toHaveBeenCalled()
  })
  it('does not expose A recovery as a pending action owned by current B', async () => {
    f.state.owner = 'B'; f.state.current.operation = operation()
    await render()
    expect(harness.container.querySelector('button')).toBeNull()
    expect(f.controller.cancel).not.toHaveBeenCalled()
  })
  it('keeps request-active cancellation blocked and reads the original result on user request', async () => {
    f.state.current.operation = operation({ confirmCancellationBlocked: true })
    await open()
    expect(cancel().disabled).toBe(true)
    await clickElement(dialog().querySelector<HTMLButtonElement>('button[type="submit"]')!)
    expect(f.controller.recoverOriginal).toHaveBeenCalledOnce()
    expect(f.controller.cancel).not.toHaveBeenCalled(); expect(f.controller.confirm).not.toHaveBeenCalled()
    expect(f.balance).not.toHaveBeenCalled()
  })
})
