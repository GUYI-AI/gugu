import { createHash } from 'node:crypto'
import { buildSystemNoticeEnvelope, buildSystemTaskEnvelope, formatDeliveryTimestamp } from '@gugu/core/local/agent/deliveryEnvelope'
import { eq } from 'drizzle-orm'
import { db } from '@main/db/client'
import { sessions } from '@main/db/schema'
import { sendMessage } from './sendMessage'

const LOGIN_ENDED: Record<string, string> = { rejected: '被本人拒绝', expired: '已过期，本人没有处理', invalidated: '已失效', cancelled: '已取消' }
/** Fixed native host only. The password authority passes metadata, never a capability or field value. */
export async function deliverPasswordBetaDecision(sessionId: string, requestId: string, status: string): Promise<void> {
  if (!['approved', 'filled', 'unavailable', 'rejected', 'expired', 'invalidated', 'cancelled'].includes(status)) throw new Error('password_delivery_unavailable')
  const row = db.select().from(sessions).where(eq(sessions.id, sessionId)).get()
  if (!row || row.archivedAt || row.runtime !== 'acp') throw new Error('password_delivery_unavailable')
  const text = status === 'filled'
    ? `本人已在卡片上填好，值已填进你标签页里的输入框（requestId ${requestId}），不会返回给你。现在按页面上的按钮（登录、保存）继续，再看结果。`
    : status === 'unavailable'
      ? `代填没有完成（requestId ${requestId}）：页面可能已经变了。确认标签页还在那个页面后，需要时重新发起。`
      : status === 'approved'
        ? `你的代填请求已获本人批准（requestId ${requestId}）。`
        : `你的代填请求${LOGIN_ENDED[status]}（requestId ${requestId}）。这次请求已结束，不要继续使用；需要时重新发起。`
  const messageId = decisionMessageId(requestId, status)
  await sendMessage({ sessionId, projectId: row.projectId, clientMessageId: messageId, kind: 'session-direct',
    text: envelope(messageId, text, status === 'filled') })
}

/** From 咕咕系统, not the person: the person sees a readable system notice, and an approval reads as something to do now. */
function envelope(messageId: string, content: string, task: boolean): string {
  const input = { messageId, content, at: formatDeliveryTimestamp(new Date().toISOString()) }
  return task ? buildSystemTaskEnvelope(input) : buildSystemNoticeEnvelope(input)
}

function decisionMessageId(requestId: string, status: string): string {
  const hex = createHash('sha256').update(JSON.stringify(['password-decision', requestId, status])).digest('hex')
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`
}

const SAVE_NEXT: Record<string, string> = {
  saved: '本人已保存。以后用 password_credentials 里的这条 credentialId；保存的值不会返回给你。',
  rejected: '本人拒绝保存。不要再次请求，除非本人主动要求。',
  expired: '这次保存请求已过期，本人没有处理。需要时重新发起。',
  invalidated: '这次保存请求已失效。需要时重新发起。',
}
/** Outcome of an Agent's save request. Metadata only: the stored values never travel back. */
export async function deliverPasswordBetaSaveResult(sessionId: string, requestId: string, status: string, credentialId?: string): Promise<void> {
  const next = SAVE_NEXT[status]
  if (!next) throw new Error('password_delivery_unavailable')
  const row = db.select().from(sessions).where(eq(sessions.id, sessionId)).get()
  if (!row || row.archivedAt || row.runtime !== 'acp') throw new Error('password_delivery_unavailable')
  const text = `你的密码保存请求有结果了（requestId ${requestId}${credentialId ? `，credentialId ${credentialId}` : ''}）：${next}`
  const messageId = decisionMessageId(requestId, `save:${status}`)
  await sendMessage({ sessionId, projectId: row.projectId, clientMessageId: messageId, kind: 'session-direct',
    text: envelope(messageId, text, false) })
}
