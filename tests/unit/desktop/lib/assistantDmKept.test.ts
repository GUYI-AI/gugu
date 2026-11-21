// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'

/** Review A10: the assistant's chat id must fit its own snapshot limit (it was refused on every write). */
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: { getOrCreateDM: async () => '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9' } }))

it("the assistant's chat id is kept across restarts (its entry fits the model's limit)", async () => {
  const { followRendererSession } = await import('../../../../apps/desktop/src/lib/replica')
  const owner = '11111111-2222-4333-8444-555555555555'
  followRendererSession('SIGNED_IN', owner)
  const { assistantDm } = await import('../../../../apps/desktop/src/lib/assistantDm')
  await assistantDm.prefetch('99999999-8888-4777-8666-555555555555')
  const block = localStorage.getItem(`gugu.readModel.v1:${owner}`) ?? ''
  expect(block).toContain('0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9')
})
