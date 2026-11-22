import type { AssistantPanelNotice } from '@gugu/core/cloud/assistantPanel'
import { assistantPanelCloud, personalAssistant } from '@/components/assistant/assistant-panel-cloud'
import { assistantAppChangeSchema } from '@/session/shared/extensions/assistant-app'
import { ensureKind, isServerRefusal, outbox, type OutboxKind } from '..'

/** A saved App change the personal assistant is told about; the edit itself is already saved in its own table. */
type AssistantNotice = { notice: AssistantPanelNotice; assistantId?: string }
const ASSISTANT_NOTICE = 'assistantNotice'

export const assistantNoticeOutboxKind: OutboxKind<AssistantNotice> = {
  name: ASSISTANT_NOTICE,
  lane: () => 'assistant',
  async send(item) {
    // No assistant to tell: one opened later reads the current state, so the notice has no one to inform.
    const assistant = item.payload.assistantId ?? await personalAssistant(item.accountId)
    if (!assistant) return
    // Metadata is informational: a notice the server refuses is dropped, it must not hold the later ones behind it.
    try { await assistantPanelCloud.notice(assistant, assistantAppChangeSchema.parse(item.payload.notice)) }
    catch (error) { if (!isServerRefusal(error)) throw error }
  },
}

export async function enqueueAssistantNotice(notice: AssistantPanelNotice, assistantId?: string): Promise<void> {
  ensureKind(outbox(), assistantNoticeOutboxKind)
  await outbox().enqueue(ASSISTANT_NOTICE, { notice, ...(assistantId ? { assistantId } : {}) }, { id: `assistant:${notice.operationId}` })
}
