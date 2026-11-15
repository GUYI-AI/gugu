// @vitest-environment jsdom
// A file whose commit failed is resent long after: the commit finds its upload permit lapsed (attachments/commit answers
// `expired`). Retrying that commit can never help, so the row uploads its bytes again when this run still holds them, and
// otherwise asks for the file again — never the bare "Upload permit expired".
import { afterEach, expect, it, vi } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { upsertMessageById } from '@gugu/core/shared/ui/messageListModels'
import { AttachmentsError } from '@gugu/core/cloud/attachmentsApi'
import * as attachmentEndpoint from '../../../../apps/desktop/src/lib/attachmentsEndpoint'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { openImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { createOutboxWiring, type OutboxWiringIo } from '../../../../apps/desktop/src/store/chatOutboxWiring'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n'

const commit = vi.hoisted(() => vi.fn())
vi.mock('@gugu/core/cloud/attachmentsApi', async (original) => ({ ...await original<object>(), commitAttachment: commit }))
vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }))
vi.mock('../../../../apps/desktop/src/lib/loading/LoadingIndicator', () => ({ LoadingIndicator: () => null }))
vi.mock('../../../../apps/desktop/src/lib/widgetLabels', () => ({ widgetReferenceTexts: async () => new Map() }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() }) }))

const ID = 'file-row'
const row: MessageItem = {
  id: ID, chat_id: 'chat-1', sender_user_id: 'owner-1', to_user_ids: null, is_whisper: false, seq: -1, content: 'report.pdf',
  content_type: 'attachment', reply_to_message_id: null, thread_root_id: null, is_thread_root: false, retracted_at: null,
  created_at: '2026-11-15T00:00:00.000Z', reactions: [], is_mine: true, delivered: false, delivery_status: null, local_send_state: 'sending',
}
const args = { message_id: ID, chat_id: 'chat-1', sender_user_id: 'owner-1', file_name: 'report.pdf', content_type: 'application/pdf', to_user_ids: [] }
const workerLimit = () => new AttachmentsError('commit', 546, 'failed', 'Worker failed to respond due to a resource limit')
const lapsed = () => new AttachmentsError('commit', 410, 'expired', 'Upload permit expired')

function harness() {
  let messages = [row]
  const repository = openImRepository('owner-1', { adapter: createMemoryLocalSyncDb(), storage: window.localStorage })
  const io: OutboxWiringIo = {
    getImRepository: () => repository, user: () => ({ id: 'owner-1', nickname: 'Owner', avatarUrl: null }), identity: () => undefined,
    chats: () => [], chatShown: id => id === 'chat-1', activeThreadRootId: () => null,
    setMessagesAndCache: updater => { messages = updater(messages) }, setThreadMessages: () => {},
    patchChat: vi.fn(), toast: vi.fn(), appendMessage: message => { messages = upsertMessageById(messages, message) },
  }
  return { wiring: createOutboxWiring(io), repository, shown: () => messages.find(m => m.id === ID) }
}
/** The commit fails on the outbox's own attempts, so the row ends failed with its staging key, as after a worker limit. */
async function failedCommit(h: ReturnType<typeof harness>, uploadAgain?: () => void) {
  vi.spyOn(attachmentEndpoint, 'attachmentsEndpoint').mockResolvedValue({ supabaseUrl: 'https://db.test', anonKey: 'anon', token: 'token' })
  commit.mockRejectedValue(workerLimit())
  await h.wiring.stageAttachment(row)
  await h.wiring.commitAttachment(row, { staging_key: 'staging/owner-1/k' }, args, undefined, undefined, uploadAgain)
  await vi.runAllTimersAsync()
  expect(h.shown()).toMatchObject({ local_send_state: 'failed', local_send_retryable: true })
}
afterEach(() => { commit.mockReset(); vi.useRealTimers(); vi.restoreAllMocks(); setLocalePreference('zh-CN') })

it('a resend whose commit finds the permit lapsed uploads the bytes this run holds again, as the same row', async () => {
  vi.useFakeTimers()
  const h = harness(), uploadAgain = vi.fn()
  await failedCommit(h, uploadAgain)
  const before = commit.mock.calls.length
  commit.mockRejectedValue(lapsed())
  h.wiring.retrySend(ID)
  await vi.runAllTimersAsync()
  expect(commit.mock.calls.length - before, 'a lapsed permit is not retried').toBe(1)
  expect(uploadAgain).toHaveBeenCalledOnce()
  expect(h.shown()?.local_send_state).toBe('sending')
  expect((await h.repository).snapshot().outbox.map(r => r.value)).toEqual([expect.objectContaining({ clientMessageId: ID, state: 'uploading', operation: { kind: 'upload' } })])
  h.wiring.dispose()
})

it('an ordinary commit failure on resend keeps the bytes in hand for a later resend', async () => {
  vi.useFakeTimers()
  const h = harness(), uploadAgain = vi.fn()
  await failedCommit(h, uploadAgain)
  h.wiring.retrySend(ID)
  await vi.runAllTimersAsync()
  expect(uploadAgain).not.toHaveBeenCalled()
  commit.mockRejectedValue(lapsed())
  h.wiring.retrySend(ID)
  await vi.runAllTimersAsync()
  expect(uploadAgain).toHaveBeenCalledOnce()
  h.wiring.dispose()
})

it.each(['zh-CN', 'en-US'] as const)('without the bytes (a reload since), the row asks for the file again instead of saying the permit expired (%s)', async locale => {
  setLocalePreference(locale)
  vi.useFakeTimers()
  const h = harness()
  await failedCommit(h)
  commit.mockRejectedValue(lapsed())
  h.wiring.retrySend(ID)
  await vi.runAllTimersAsync()
  expect(h.shown()).toMatchObject({ local_send_state: 'failed', local_send_retryable: false,
    local_send_error: locale === 'zh-CN' ? '上传已中断，请重新选择文件。' : 'Upload interrupted. Select the file again.' })
  h.wiring.dispose()
})

it('uploads again on its own at most once per send: lapsed again, the row stops, says it timed out, and keeps resend for the person', async () => {
  vi.useFakeTimers()
  const h = harness()
  // Like the composer's closure: the bytes go up again, then the row is committed again (and finds the permit lapsed again).
  const uploadAgain = vi.fn(() => { void h.wiring.commitAttachment(row, { staging_key: `staging/owner-1/k${uploadAgain.mock.calls.length}` }, args, undefined, undefined, uploadAgain) })
  await failedCommit(h, uploadAgain)
  commit.mockRejectedValue(lapsed())
  h.wiring.retrySend(ID)
  await vi.runAllTimersAsync()
  expect(uploadAgain, 'one automatic upload, not a loop').toHaveBeenCalledOnce()
  expect(h.shown()).toMatchObject({ local_send_state: 'failed', local_send_retryable: true, local_send_error: '发送超时，请稍后重新发送' })
  // The person resends: the row may upload itself again once more.
  h.wiring.retrySend(ID)
  await vi.runAllTimersAsync()
  expect(uploadAgain).toHaveBeenCalledTimes(2)
  h.wiring.dispose()
})
