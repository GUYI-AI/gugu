// Why the server kept a message but refused it to one addressed agent: archived task (restorable) or removed identity (not).
// A reason this client does not know yet is still a refusal of a message that IS in the chat: report it as not delivered,
// never as a failed send (an agent would send it again) — #2383.
const REFUSALS = {
  agent_archived: { label: '对方已归档、未送达', after: 'no replay after restoration' },
  identity_removed: { label: '对方已移除、未送达', after: 'the identity cannot be restored' },
}

/** Read the immutable recipient result, never infer it from current presence. */
export async function messageDeliveryBlocks(deps, messageId) {
  const rows = await deps.restGet(`message_agent_delivery_blocks?message_id=eq.${encodeURIComponent(messageId)}&select=agent_user_id,reason`, 'chat')
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
  return [...known, ...unknown.map((reason) => [reason, { label: '未送达', after: 'a reason this client does not know yet' }])].flatMap(([reason, { label, after }]) => {
    const refused = blocks.filter((row) => row.reason === reason)
    return refused.length ? [`${label} (${refused.map((row) => `user:${row.agent_user_id}`).join(', ')}; ${reason}; retained in history, ${after})`] : []
  })
}

export async function archivedDeliveryReceipt(deps, messageId) {
  return deliveryRefusalNotes(await messageDeliveryBlocks(deps, messageId)).map((note) => `; ${note}`).join('')
}
