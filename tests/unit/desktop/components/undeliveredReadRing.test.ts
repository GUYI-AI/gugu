// @vitest-environment jsdom
// 一个 agent 没有运行中的实例持有它,只是那一个 agent 的事:气泡旁写它未送达,整条消息的已读环照常挂、照常能点开。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageBubble } from '../../../../apps/desktop/src/components/chat/MessageBubble'
import { createNode, createReactHarness, message, renderWithAppProviders } from '../../../support/testHarness'
vi.mock('../../../../apps/desktop/src/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => harness.cleanup())

describe('a message one agent could not get', () => {
  it('keeps its read ring next to that agent\'s undelivered line', async () => {
    await renderWithAppProviders(harness, createNode(MessageBubble, {
      msg: message({ id: 'mine', is_mine: true, seq: 5 }), onReaction: vi.fn(), onQuote: vi.fn(), onForward: vi.fn(), onDelete: vi.fn(),
      sendState: 'delivered', undeliveredTo: 'agent-1', showReadReceipt: true, readReceiptRead: 1, readReceiptTotal: 3,
    }))
    expect(harness.container.querySelector('[data-send-state="undelivered"][data-agent-id="agent-1"]')).not.toBeNull()
    expect(harness.container.querySelector('[data-testid="message-read-receipt"]')?.getAttribute('aria-label')).toContain('1')
  })
})
