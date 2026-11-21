import type { AssistantPanelNotice } from '@gugu/core/cloud/assistantPanel'
import { assistantPanelCloud, personalAssistant } from '@/components/assistant/assistant-panel-cloud'
import { assistantAppChangeSchema } from '@/session/shared/extensions/assistant-app'
import { ensureKind, outbox, type OutboxKind } from '..'

/** A saved App change the personal assistant is told about; the edit itself is already saved in its own table. */
type AssistantNotice = { notice: AssistantPanelNotice; assistantId?: string }
const ASSISTANT_NOTICE = 'assistantNotice'
// Metadata is informational: a notice the server refuses must not hold the later ones behind it.
const REFUSED = ['22023', '23505', '54000', '55000', '42501']

export const assistantNoticeOutboxKind: OutboxKind<AssistantNotice> = {
  name: ASSISTANT_NOTICE,
  lane: () => 'assistant',
  async send(item) {
    // No assistant to tell: one opened later reads the current state, so the notice has no one to inform.
    const assistant = item.payload.assistantId ?? await personalAssistant(item.accountId)
    if (!assistant) return
    try { await assistantPanelCloud.notice(assistant, assistantAppChangeSchema.parse(item.payload.notice)) }
    catch (error) { if (!REFUSED.includes(String((error as { code?: string }).code))) throw error }
  },
}

export async function enqueueAssistantNotice(notice: AssistantPanelNotice, assistantId?: string): Promise<void> {
  ensureKind(outbox(), assistantNoticeOutboxKind)
  await outbox().enqueue(ASSISTANT_NOTICE, { notice, ...(assistantId ? { assistantId } : {}) }, { id: `assistant:${notice.operationId}` })
}
