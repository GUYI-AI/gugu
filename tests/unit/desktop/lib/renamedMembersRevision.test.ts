import { describe, expect, it, vi } from 'vitest'

/**
 * `agent_changed` is read in a subscriber callback, a batch at a time (App pages told a member was renamed, #2211): one
 * payload without `agent_user_id` is skipped and said, and the others in the batch still count.
 */
const warned = vi.hoisted(() => [] as Array<{ data: unknown; message: string }>)
vi.mock('../../../../apps/desktop/src/lib/log', () => {
  const logger = { warn: (data: unknown, message: string) => void warned.push({ data, message }), error: vi.fn(), info: vi.fn(), debug: vi.fn() }
  return { rendererLogger: () => logger }
})

const { readRenamedMembers } = await import('../../../../apps/desktop/src/lib/accountRevisionCoordinator')

describe('the people agent_changed names, a batch at a time (readRenamedMembers)', () => {
  it('a malformed payload in the batch is skipped and warned about; the rest are read', () => {
    const ids = readRenamedMembers([{ agent_user_id: 'a' }, { entity_id: 'x' }, null, { agent_user_id: '' }, { agent_user_id: 'b' }])
    expect(ids).toEqual(['a', 'b'])
    expect(warned).toHaveLength(3)
    expect(warned.every(({ message }) => message.includes('agent_user_id'))).toBe(true)
  })
})
