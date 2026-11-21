// @vitest-environment jsdom
// The flood ledger of a chat: one read when the chat opens (❌ a second one for the system message already there); a
// system message landing while it is shown asks again.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const reads = vi.hoisted(() => vi.fn())
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  chatDb: { from: () => ({ select: () => ({ eq: () => ({ order: () => ({ limit: async () => { reads(); return { data: [{ message_id: 'sys-1' }], error: null } } }) }) }) }) },
}))

const { useAgentFloodNotice } = await import('../../../../apps/desktop/src/hooks/useAgentFloodNotice')
const { followRendererSession, queryClient } = await import('../../../../apps/desktop/src/lib/replica')

describe('useAgentFloodNotice reads', () => {
  it('opening a chat with a system message reads the ledger once; a new system message reads it again', async () => {
    queryClient.clear()
    followRendererSession('SIGNED_IN', 'me')
    let messages = [{ id: 'sys-1', content_type: 'system' }]
    function Probe() { useAgentFloodNotice('chat-1', messages); return null }
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(<Probe />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(reads).toHaveBeenCalledTimes(1)
    messages = [...messages, { id: 'sys-2', content_type: 'system' }]
    await act(async () => root.render(<Probe />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(reads).toHaveBeenCalledTimes(2)
    await act(async () => root.unmount())
  })
})
