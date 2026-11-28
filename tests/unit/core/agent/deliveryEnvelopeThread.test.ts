import { describe, expect, it } from 'vitest'
import { buildAgentDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope'

// An envelope's ids are typed as the tools take them: `thread=` is passed to message_history's thread_root_id as written.
describe('delivery envelope thread', () => {
  it('writes the thread root as a msg: id, like msg=', () => {
    const root = '61000000-0000-4000-8000-000000000001'
    const envelope = buildAgentDeliveryEnvelope({
      guguUserId: '11111111-1111-4111-8111-111111111111',
      chatId: '22222222-2222-4222-8222-222222222222',
      messageId: '33333333-3333-4333-8333-333333333333',
      senderUserId: '44444444-4444-4444-8444-444444444444',
      content: 'hi',
      replyTo: null,
      threadRootId: root,
    }, new Map(), { publicId: null, name: 'g', kind: 'group' }, '2026-11-27T00:00:00.000Z')
    expect(envelope).toContain(`thread="msg:${root}"`)
  })
})
