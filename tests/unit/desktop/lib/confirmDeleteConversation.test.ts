import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ modal: vi.fn(), boundary: new AbortController() }))
vi.mock('../../../../apps/desktop/src/lib/conversationDeleteConfirmation', () => ({ requestConversationDeleteConfirmation: state.modal }))
vi.mock('../../../../apps/desktop/src/lib/authSessionLoss', () => ({ currentAuthSessionSignal: () => state.boundary.signal }))
import { confirmDeleteConversation } from '../../../../apps/desktop/src/lib/confirmDeleteConversation'

beforeEach(() => {
  vi.clearAllMocks()
  state.boundary = new AbortController()
})
describe('clear history confirmation', () => {
  it('clears only on confirmation', async () => {
    const clear = vi.fn().mockResolvedValue(undefined)
    state.modal.mockResolvedValueOnce(true)
    await confirmDeleteConversation({ name: '设计评审', clear })
    expect(state.modal).toHaveBeenCalledWith(state.boundary.signal, '设计评审')
    expect(clear).toHaveBeenCalledTimes(1)
  })
  it('does nothing when cancelled or when the account session ended meanwhile', async () => {
    const clear = vi.fn().mockResolvedValue(undefined)
    state.modal.mockResolvedValueOnce(null)
    await confirmDeleteConversation({ clear })
    state.modal.mockImplementationOnce(async () => { state.boundary.abort(); return true })
    await confirmDeleteConversation({ clear })
    expect(clear).not.toHaveBeenCalled()
  })
})
