import { describe, expect, it, vi } from 'vitest'
import { PERMANENT_REMOVAL_RPCS, PURGE_HISTORY_BATCH, purgeOwnedAgentHistory } from '../../../../packages/core/src/cloud/agentIdentityRemoval'

const client = (data: unknown, error: { message: string } | null = null) => ({ rpc: vi.fn(async () => ({ data, error })) })

describe('purgeOwnedAgentHistory (purge_owned_agent_history, 已归档 → 永久删除)', () => {
  it('sends the deduplicated ids under the one RPC name and returns the receipt', async () => {
    const c = client({ purged: ['a', 'b'], conversations: 2 })
    await expect(purgeOwnedAgentHistory(c, ['a', 'b', 'a', ''])).resolves.toEqual({ purged: ['a', 'b'], conversations: 2 })
    expect(c.rpc).toHaveBeenCalledWith(PERMANENT_REMOVAL_RPCS.history, { p_agent_user_ids: ['a', 'b'] })
    expect(PERMANENT_REMOVAL_RPCS.history).toBe('purge_owned_agent_history')
  })
  it('takes 1 to 50 ids per call; more is the caller\'s job to chunk', async () => {
    const ids = Array.from({ length: PURGE_HISTORY_BATCH + 1 }, (_, i) => `a${i}`)
    expect(PURGE_HISTORY_BATCH).toBe(50)
    await expect(purgeOwnedAgentHistory(client({ purged: [], conversations: 0 }), ids)).rejects.toThrow('1 to 50')
    await expect(purgeOwnedAgentHistory(client({ purged: [], conversations: 0 }), [])).rejects.toThrow('1 to 50')
    await expect(purgeOwnedAgentHistory(client({ purged: ids.slice(0, 50), conversations: 0 }), ids.slice(0, 50))).resolves.toBeTruthy()
  })
  it('fails loud on a backend error or a receipt for other identities', async () => {
    await expect(purgeOwnedAgentHistory(client(null, { message: 'identity is still live' }), ['a'])).rejects.toThrow('identity is still live')
    await expect(purgeOwnedAgentHistory(client({ purged: ['someone-else'], conversations: 1 }), ['a'])).rejects.toThrow('does not match')
    await expect(purgeOwnedAgentHistory(client({ purged: ['a'] }), ['a'])).rejects.toThrow('does not match')
  })
})
