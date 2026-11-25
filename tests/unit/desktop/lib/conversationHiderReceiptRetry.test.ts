// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createConversationHider } from '../../../../apps/desktop/src/lib/conversationHider'

describe('retrying a confirmed Hide receipt', () => {
  it.each([false, true])('checks whether a saved receipt is superseded (%s)', async superseded => {
    const boundary = new AbortController().signal
    const saved = new Map<string, string>()
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => { saved.set(key, value) },
      removeItem: (key: string) => { saved.delete(key) },
    }
    const hide = vi.fn(async (chatId: string, operationId: string) => ({
      chat_id: chatId, operation_id: operationId, hidden_at: '2026-11-24T18:00:00Z', account_revision: '12',
    }))
    const confirm = vi.fn(async () => {})
    const deps = { hide, confirm, boundary: () => boundary, storage, storageKey: 'hide' }
    confirm.mockRejectedValueOnce(new Error('local publication failed'))
    const initial = createConversationHider({ ...deps, operationId: () => 'original' })
    await expect(initial('account', 'chat')).rejects.toThrow('local publication failed')

    const isReceiptSuperseded = vi.fn(() => superseded)
    const resumed = createConversationHider({ ...deps, operationId: () => 'next', isReceiptSuperseded })
    const retries = [resumed('account', 'chat'), resumed('account', 'chat')]
    expect(retries[0]).toBe(retries[1])
    const [receipt] = await Promise.all(retries)
    expect(isReceiptSuperseded).toHaveBeenCalledWith('account', expect.objectContaining({ operation_id: 'original' }))
    expect(receipt?.operation_id).toBe(superseded ? 'next' : 'original')
    expect(hide.mock.calls).toEqual(superseded ? [['chat', 'original'], ['chat', 'next']] : [['chat', 'original']])
  })
})
