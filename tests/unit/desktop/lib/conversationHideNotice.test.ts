import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Notice } from '../../../../apps/desktop/src/lib/notices'
import type { PersonalConversationUndo } from '../../../../apps/desktop/src/lib/undoListedConversation'
const notices = vi.hoisted(() => ({ notify: vi.fn(), dismissNotice: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/notices', () => notices)
import { showConversationHideNotice } from '../../../../apps/desktop/src/lib/conversationHideNotice'
import { i18n } from '../../../../apps/desktop/src/i18n'

const receipt = { chat_id: 'room', hidden_at: '2026-11-19T00:00:00Z', operation_id: 'hide-1', account_revision: '9007199254740993' }
const restored: PersonalConversationUndo = { chat_id: 'room', hidden_at: null, operation_id: 'undo-1', hide_operation_id: 'hide-1', account_revision: '9007199254740994', restored: true }
const controllers: AbortController[] = []
const latest = () => notices.notify.mock.calls.at(-1)![0] as Notice
function show(undo: () => Promise<PersonalConversationUndo | undefined>, operation = 'hide-1') {
  const boundary = new AbortController(); controllers.push(boundary)
  showConversationHideNotice({ accountId: 'owner', name: '设计协作', receipt: { ...receipt, operation_id: operation }, boundary: boundary.signal, undo })
  return boundary
}
beforeEach(async () => { vi.clearAllMocks(); await i18n.changeLanguage('zh-CN') })
afterEach(() => { for (const controller of controllers.splice(0)) controller.abort() })

it('offers Undo after hiding and sends it only after an explicit click', async () => {
  const undo = vi.fn(async () => restored)
  show(undo)
  expect(latest().title).toContain('设计协作')
  expect(latest().action?.label).toBe('撤销')
  expect(undo).not.toHaveBeenCalled()
  latest().action!.onClick()
  await vi.waitFor(() => expect(notices.dismissNotice).toHaveBeenCalledWith('conversation-hide:owner:room'))
  expect(undo).toHaveBeenCalledOnce()
})
it('does not replace or dismiss a newer hide notice when an older Undo completes', async () => {
  let finish!: (value: PersonalConversationUndo) => void
  const pending = new Promise<PersonalConversationUndo>(resolve => { finish = resolve })
  show(() => pending)
  const old = latest(); old.action!.onClick(); old.onDismiss?.()
  show(async () => ({ ...restored, hide_operation_id: 'hide-2' }), 'hide-2')
  const newer = latest()
  finish(restored); await pending; await Promise.resolve()
  expect(latest()).toBe(newer)
  expect(notices.notify).toHaveBeenCalledTimes(2)
  expect(notices.dismissNotice).not.toHaveBeenCalled()
})
it('dismisses its notice on account change and prevents a stale action', () => {
  const undo = vi.fn(async () => restored)
  const boundary = show(undo), notice = latest()
  boundary.abort(); notice.action!.onClick()
  expect(undo).not.toHaveBeenCalled()
  expect(notices.dismissNotice).toHaveBeenCalledWith('conversation-hide:owner:room')
})
it('offers an explicit retry after failure and removes the notice only after confirmed Undo', async () => {
  const undo = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(restored)
  show(undo); latest().action!.onClick()
  await vi.waitFor(() => expect(latest().tier).toBe('error'))
  expect(notices.dismissNotice).not.toHaveBeenCalled()
  latest().action!.onClick()
  await vi.waitFor(() => expect(notices.dismissNotice).toHaveBeenCalledWith('conversation-hide:owner:room'))
  expect(undo).toHaveBeenCalledTimes(2)
})
it('keeps newer server state and explains an Undo which no longer applies', async () => {
  show(async () => ({ ...restored, restored: false, hidden_at: receipt.hidden_at }))
  latest().action!.onClick()
  await vi.waitFor(() => expect(latest().tier).toBe('info'))
  expect(latest().action).toBeUndefined()
  expect(notices.dismissNotice).not.toHaveBeenCalled()
})
