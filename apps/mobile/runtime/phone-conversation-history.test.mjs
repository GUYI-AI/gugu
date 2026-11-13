import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPhoneConversationHistory } from './phone-conversation-history.mjs'

test('phone history survives a lost connection with its last confirmed clear boundary, but never masks a denial', async () => {
  const floor = '2026-11-14T00:00:00.000501Z'
  const agent = { chatId: 'chat' }
  let result = [{ chat_id: 'chat', user_id: 'owner', conversation_cleared_at: floor }], error
  const cloud = { rpc: async () => { if (error) throw error; return result } }
  const store = { save: async () => {} }
  await createPhoneConversationHistory({ cloud, store, ownerId: 'owner' })(agent)
  error = new Error('fetch failed')
  assert.equal(await createPhoneConversationHistory({ cloud, store, ownerId: 'owner' })(agent), floor)
  error = new Error('permission denied')
  await assert.rejects(createPhoneConversationHistory({ cloud, store, ownerId: 'owner' })(agent), /permission denied/)
  error = null; result = [{ chat_id: 'chat', user_id: 'owner', conversation_cleared_at: null }]
  assert.equal(await createPhoneConversationHistory({ cloud, store, ownerId: 'owner' })(agent), floor)
})

test('phone history cannot use another account or an unconfirmed schema as a successful read', async () => {
  const agent = { chatId: 'chat' }, store = { save: async () => {} }
  for (const row of [{ chat_id: 'chat', user_id: 'other', conversation_cleared_at: null }, { chat_id: 'chat', user_id: 'owner' }]) {
    const cloud = { rpc: async () => [row] }
    await assert.rejects(createPhoneConversationHistory({ cloud, store, ownerId: 'owner' })(agent), /not confirmed/)
  }
  const cloud = { rpc: async () => { throw new Error('network unavailable') } }
  await assert.rejects(createPhoneConversationHistory({ cloud, store, ownerId: 'owner' })(agent), /network unavailable/)
})
