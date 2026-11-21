import { afterEach, describe, expect, it, vi } from 'vitest'
import { settledAgentLookPoster } from '../../../../apps/desktop/src/components/agentAvatar/posters'
import { runtime } from '../../../../apps/desktop/src/components/agentAvatar/engine/runtime'
import type { AgentLook } from '../../../../apps/desktop/src/components/agentAvatar/look'

// #3432 A notification asks for an agent's look still. When the engine could not draw it (it waits 15 s for sprites, then
// gives up), the interface must not start another wait on every render — but the next notification may ask again.
const LOOK: AgentLook = { color: 3, rest: 'neutral' }

describe('settledAgentLookPoster after a failed draw', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('stays failed for the interface, is drawn again for a caller that can retry', async () => {
    const still = vi.spyOn(runtime, 'still')
      .mockRejectedValueOnce(new Error('still timed out waiting for sprites'))
      .mockResolvedValue('blob:poster')
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(settledAgentLookPoster(LOOK)).rejects.toThrow('timed out')
    await expect(settledAgentLookPoster(LOOK), 'no retry unless asked').rejects.toThrow('timed out')
    expect(still).toHaveBeenCalledTimes(1)

    await expect(settledAgentLookPoster(LOOK, { retryFailed: true })).resolves.toBe('blob:poster')
    expect(still).toHaveBeenCalledTimes(2)
    await expect(settledAgentLookPoster(LOOK), 'drawn once now, kept').resolves.toBe('blob:poster')
    expect(still).toHaveBeenCalledTimes(2)
  })
})
