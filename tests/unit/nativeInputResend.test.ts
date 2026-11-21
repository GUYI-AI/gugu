// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { runInAction } from 'mobx'
import { modalStore } from '@renderer/lib/modal/modal-store'
import { resendNativeInputByPerson } from '@/lib/nativeInputResend'

const mocks = vi.hoisted(() => ({ succeeded: vi.fn(), failed: vi.fn() }))
vi.mock('@/lib/nativeInputFailureNotice', () => ({ runNativeInputAction: async (_session: string, _id: string, _device: string | null,
  action: () => Promise<unknown>, report: (error: unknown, attempt: { failed: typeof mocks.failed }) => void) => {
  try { await action(); mocks.succeeded(); return true } catch (error) { report(error, { failed: mocks.failed }); return false }
} }))
vi.mock('@renderer/localization/locale-store', () => ({ translateSessionMessage: (key: string, args?: { reason: string }) => `${key}${args ? `:${args.reason}` : ''}` }))
vi.mock('@/lib/userFacingError', () => ({ messageForUser: (error: unknown) => String(error instanceof Error ? error.message : error) }))

const check = { kind: 'confirmation-required' as const, confirmation: 'one-use', reason: 'native_tail_does_not_cover_history' }
afterEach(() => { modalStore.closeModal(); vi.clearAllMocks() })

async function dialog() {
  await vi.waitFor(() => expect(modalStore.activeModalId).toBe('confirmActionModal'))
  return modalStore.activeModalArgs!
}

it('uses the existing modal with the actual reason and only confirming submits the original token', async () => {
  const retry = vi.fn().mockResolvedValueOnce(check).mockResolvedValueOnce({ kind: 'done' })
  const action = resendNativeInputByPerson('s', 'm', 'device', retry)
  const args = await dialog()
  expect(args.description).toContain('nativeResend.reason.tail')
  expect(args.confirmLabel).toBe('nativeResend.confirm')
  expect(retry.mock.calls).toEqual([[{ allowConfirmation: true }]])
  args.onSuccess(); await action
  expect(retry.mock.calls).toEqual([[{ allowConfirmation: true }], [{ allowConfirmation: true, confirmation: 'one-use' }]])
});

it('cancelling leaves the row unresolved and makes no confirmation RPC', async () => {
  const retry = vi.fn().mockResolvedValue(check)
  const action = resendNativeInputByPerson('s', 'cancel', null, retry)
  const args = await dialog(); args.onClose(); await action
  expect(retry).toHaveBeenCalledTimes(1)
});

it('coalesces two clicks and settles a replaced dialog without keeping the message blocked', async () => {
  const retry = vi.fn().mockResolvedValue(check)
  const first = resendNativeInputByPerson('s', 'replace', null, retry)
  expect(resendNativeInputByPerson('s', 'replace', null, retry)).toBe(first)
  await dialog()
  runInAction(() => { modalStore.request++; modalStore.activeModalId = 'anotherModal' })
  await first; expect(retry).toHaveBeenCalledTimes(1)
  retry.mockResolvedValue({ kind: 'done' })
  await resendNativeInputByPerson('s', 'replace', null, retry)
  expect(retry).toHaveBeenCalledTimes(2)
});

it('does not ask for consent when the echo was found, and reports actual action failures', async () => {
  await resendNativeInputByPerson('s', 'found', null, vi.fn().mockResolvedValue({ kind: 'done' }))
  expect(modalStore.isOpen).toBe(false)
  await resendNativeInputByPerson('s', 'failure', null, vi.fn().mockRejectedValue(new Error('native_session_changed')))
  expect(mocks.failed).toHaveBeenCalledWith(expect.objectContaining({ description: 'native_session_changed' }))
});
