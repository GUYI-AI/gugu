import { agentReceiptNote } from '@gugu/core/shared/agentReceiptNote'

// Why the server kept a message but refused it to one addressed agent: archived task (restorable) or removed identity (not).
// A reason this client does not know yet is still a refusal of a message that IS in the chat: report it as not delivered,
// never as a failed send (an agent would send it again) — #2383.
const REFUSALS = {
  agent_archived: { label: 'not delivered, recipient archived', after: 'no replay after restoration' },
  identity_removed: { label: 'not delivered, recipient removed', after: 'the identity cannot be restored' },
}

/** Reuse the send's room facts to choose exactly one post-commit read on both old and new databases. */
export async function readSendReceipt(deps, chatId, messageId, includeNotice) {
  let rows, notice
  try {
    if (includeNotice && deps.state.chatFacts?.get(chatId)?.agent_send_receipt === true) {
      const result = await deps.restRpc('agent_send_receipt', { p_as: deps.context.agentId, p_message_id: messageId })
      rows = refusalRows(result?.blocks)
      notice = exceptionNote(result?.exception)
    } else {
      const result = await deps.restGet(`message_agent_delivery_blocks?message_id=eq.${encodeURIComponent(messageId)}&select=agent_user_id,reason`, 'chat')
      rows = refusalRows(result)
    }
  } catch {
    return { delivery_status: 'unverified', delivery_note: 'The message was sent, but recipient delivery could not be verified. Do not send it again.' }
  }
  return {
    ...(rows.length ? { not_delivered_to: rows, delivery_note: deliveryRefusalNotes(rows).join('; ') } : {}),
    ...(notice ? { recipient_note: notice } : {}),
  }
}

function exceptionNote(exception) {
  if (!exception) return null
  let note = agentReceiptNote(exception.kind)
  if (exception.kind === 'offline') {
    const host = exception.host_label ? `Host ${JSON.stringify(exception.host_label)}` : 'Host'
    const lastSeen = Date.parse(exception.last_seen_at)
    const time = Number.isFinite(lastSeen) ? new Date(lastSeen).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : null
    note = `${host} offline${time ? ` (last seen ${time})` : ''}`
  }
  if (!note) return null
  const recipient = exception.agent_user_id ? `user:${exception.agent_user_id}: ` : ''
  const others = exception.others > 0 ? ` (+${exception.others} other affected)` : ''
  return `${recipient}${note}${others}.`
}

function refusalRows(rows) {
  if (!Array.isArray(rows)) throw new Error('Message delivery refusal result is unavailable')
  return rows.map((row) => {
    if (typeof row.agent_user_id !== 'string' || typeof row.reason !== 'string' || !row.reason) throw new Error('Invalid message delivery refusal result')
    return { agent_user_id: row.agent_user_id, reason: row.reason }
  })
}

/** One clause per refusal reason, in a fixed order; empty when every addressed agent was reached. */
export function deliveryRefusalNotes(blocks) {
  const unknown = [...new Set(blocks.map((row) => row.reason).filter((reason) => !Object.hasOwn(REFUSALS, reason)))]
  const known = Object.entries(REFUSALS)
  return [...known, ...unknown.map((reason) => [reason, { label: 'not delivered', after: 'a reason this client does not know yet' }])].flatMap(([reason, { label, after }]) => {
    const refused = blocks.filter((row) => row.reason === reason)
    return refused.length ? [`${label} (${refused.map((row) => `user:${row.agent_user_id}`).join(', ')}; ${reason}; retained in history, ${after})`] : []
  })
}
