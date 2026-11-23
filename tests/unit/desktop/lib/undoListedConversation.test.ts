import { beforeEach, expect, it, vi } from 'vitest'
const api = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: api }))
import { undoListedConversation } from '../../../../apps/desktop/src/lib/undoListedConversation'
const receipt = { chat_id: 'room', operation_id: 'undo', hide_operation_id: 'hide', hidden_at: null, restored: true, account_revision: '9007199254740993' }
beforeEach(() => { api.rpc.mockReset(); api.rpc.mockResolvedValue({ data: receipt, error: null }) })
it('uses the checked RPC and retains exact operation IDs and a lossless revision', async () => {
  expect(await undoListedConversation('room', 'hide', 'undo')).toEqual(receipt)
  expect(api.rpc).toHaveBeenCalledWith('undo_my_conversation_hide', { p_chat_id: 'room', p_hide_operation_id: 'hide', p_operation_id: 'undo' })
})
it.each([
  { chat_id: 'other' },
  { account_revision: 9007199254740992 }, { account_revision: '01' },
  { restored: true, hidden_at: '2026-11-19T00:00:00Z' }, { restored: false, hidden_at: 'invalid' },
])('rejects an unconfirmed or mismatched operation receipt %j', async changed => {
  api.rpc.mockResolvedValue({ data: { ...receipt, ...changed }, error: null })
  await expect(undoListedConversation('room', 'hide', 'undo')).rejects.toThrow('not confirmed')
})
it('retains an authoritative newer hidden state without claiming restoration', async () => {
  const current = { ...receipt, restored: false, hidden_at: '2026-11-19T00:00:01Z' }
  api.rpc.mockResolvedValue({ data: current, error: null })
  expect(await undoListedConversation('room', 'hide', 'undo')).toEqual(current)
})
it('propagates denied and unavailable requests instead of synthesizing success', async () => {
  api.rpc.mockResolvedValue({ data: null, error: { message: 'membership denied' } })
  await expect(undoListedConversation('room', 'hide', 'undo')).rejects.toThrow('membership denied')
  api.rpc.mockRejectedValue(new Error('offline'))
  await expect(undoListedConversation('room', 'hide', 'undo')).rejects.toThrow('offline')
})
