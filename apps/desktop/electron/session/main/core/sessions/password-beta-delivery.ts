import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '@main/db/client'
import { sessions } from '@main/db/schema'
import { sendMessage } from './sendMessage'

/** Fixed native host only. The password authority passes metadata, never a capability or field value. */
export async function deliverPasswordBetaDecision(sessionId: string, requestId: string, status: string): Promise<void> {
  if (!['approved', 'rejected', 'expired', 'invalidated', 'cancelled'].includes(status)) throw new Error('password_delivery_unavailable')
  const row = db.select().from(sessions).where(eq(sessions.id, sessionId)).get()
  if (!row || row.archivedAt || row.runtime !== 'acp') throw new Error('password_delivery_unavailable')
  const text = JSON.stringify({ requestId, status,
    next: status === 'approved' ? '本人已批准本次使用。调用 password_login，action=start，requestId 为本条请求；密码不会返回给你。' : '本次密码请求已结束。不要继续使用；需要时重新发起请求。' })
  await sendMessage({ sessionId, projectId: row.projectId, clientMessageId: decisionMessageId(requestId, status),
    kind: 'session-direct', text: `<gugu_password_decision>\n${text}\n</gugu_password_decision>` })
}

function decisionMessageId(requestId: string, status: string): string {
  const hex = createHash('sha256').update(JSON.stringify(['password-decision', requestId, status])).digest('hex')
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`
}

const SAVE_NEXT: Record<string, string> = {
  saved: '本人已保存。以后登录时用 password_credentials 里的这条 credentialId；密码不会返回给你。',
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
  const text = JSON.stringify({ requestId, kind: 'save', status, ...(credentialId ? { credentialId } : {}), next })
  await sendMessage({ sessionId, projectId: row.projectId, clientMessageId: decisionMessageId(requestId, `save:${status}`),
    kind: 'session-direct', text: `<gugu_password_decision>\n${text}\n</gugu_password_decision>` })
}
