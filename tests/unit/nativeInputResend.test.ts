// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { runInAction } from 'mobx'
import { modalStore } from '@renderer/lib/modal/modal-store'
import { resendNativeInputByPerson } from '@/lib/nativeInputResend'
import { enUSMessages, zhCNMessages } from '@renderer/localization/messages'

const mocks = vi.hoisted(() => ({ succeeded: vi.fn(), failed: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ debug: () => {}, info: () => {}, warn: mocks.warn, error: mocks.error }) }))
vi.mock('@/lib/nativeInputFailureNotice', () => ({ runNativeInputAction: async (_session: string, _id: string, _device: string | null,
  action: () => Promise<unknown>, report: (error: unknown, attempt: { failed: typeof mocks.failed }) => void) => {
  try { await action(); mocks.succeeded(); return true } catch (error) { report(error, { failed: mocks.failed }); return false }
} }))
vi.mock('@renderer/localization/locale-store', () => ({ translateSessionMessage: (key: string, args?: { reason: string }) => `${key}${args ? `:${args.reason}` : ''}` }))

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
  expect(mocks.failed).toHaveBeenCalledWith(expect.objectContaining({ description: 'nativeResend.action.changed' }))
  expect(mocks.error).toHaveBeenCalledWith(expect.objectContaining({ error: 'Error: native_session_changed' }), expect.any(String))
});

it.each([
  ['native_tail_does_not_cover_history', 'tail'],
  ['native_record_boundary_missing', 'record'], ['native_record_incomplete', 'record'], ['native_record_invalid', 'record'],
  ['native_source_changed', 'changed'], ['native_session_changed', 'changed'], ['native_read_budget_exhausted', 'budget'],
  ['native_source_unreadable', 'unreadable'], ['native_lookup_failed', 'unreadable'],
  ['native_session_unavailable', 'unavailable'], ['native_location_unavailable', 'unavailable'], ['native_format_not_supported', 'unavailable'],
  ['native_session_identity_unavailable', 'identity'], ['native_input_identity_unavailable', 'identity'],
  ['future_host_reason_with_internal_details', 'unknown'],
  ['constructor', 'unknown'], ['toString', 'unknown'],
])('maps %s to fixed copy and keeps original diagnostics only in logs', async (reason, copy) => {
  const detail = 'EACCES /fixture/private/transcript.jsonl internal-diagnostic-marker';
  const retry = vi.fn().mockResolvedValue({ ...check, reason, detail });
  const action = resendNativeInputByPerson('s', reason, null, retry);
  const args = await dialog();
  expect(args.description).toBe(`nativeResend.reason.${copy}\n\nnativeResend.description`);
  expect(args.description).not.toContain(reason); expect(args.description).not.toContain(detail);
  expect(mocks.warn).toHaveBeenCalledWith(expect.objectContaining({ reason, detail }), expect.any(String));
  args.onClose(); await action;
  expect(retry).toHaveBeenCalledTimes(1);
});

it('keeps unexpected RPC details out of notices while preserving them in diagnostics', async () => {
  const detail = 'Unexpected internal diagnostic /fixture/private/socket';
  await resendNativeInputByPerson('s', 'unknown-failure', null, vi.fn().mockRejectedValue(new Error(detail)));
  expect(mocks.failed).toHaveBeenCalledWith(expect.objectContaining({ description: 'nativeResend.action.failed' }));
  expect(mocks.error).toHaveBeenCalledWith(expect.objectContaining({ error: `Error: ${detail}` }), expect.any(String));
});

it.each([
  ['en-US', enUSMessages, "the agent's conversation record"],
  ['zh-CN', zhCNMessages, 'Agent 那边的对话记录'],
] as const)('uses plain conversation-record wording in all %s resend explanations', (_locale, catalog, phrase) => {
  for (const reason of ['tail', 'record', 'changed', 'budget', 'unreadable', 'unavailable', 'identity'] as const) {
    const copy = catalog[`nativeResend.reason.${reason}`];
    expect(copy.toLowerCase()).toContain(phrase.toLowerCase());
    expect(copy).not.toMatch(/原生记录|native history|native record/i);
  }
});
