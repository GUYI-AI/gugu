import { describe, expect, it } from 'vitest'
import { buildAgentDeliveryEnvelope, mergeDeliveryEnvelopes, readDeliveryEnvelope } from '../../../../packages/core/src/local/agent/deliveryEnvelope'

const input = {
  guguUserId: 'agent-1', chatId: 'b8f0ac44-4e5f-4c33-aa13-4db560055840',
  messageId: '7fae645e-7afd-4f80-9591-f75a5462fc3b', senderUserId: 'sender-1',
  content: '', replyTo: null, threadRootId: null,
}
const people = new Map([['sender-1', { guguNumber: 7, displayName: 'Sender' }]])
const group = { publicId: 123, name: 'Group', kind: 'group' as const }
const spec = { v: 2, text: 'Counter', app: 'counter', view: 'main', data: { count: 2 } }

describe('widget identity on the canonical delivery envelope', () => {
  it.each([undefined, 'independent-widget / "<&'])('keeps message identity and widget identity distinct: %s', wid => {
    const content = JSON.stringify({ ...spec, ...(wid ? { wid } : {}) })
    const envelope = buildAgentDeliveryEnvelope({ ...input, contentType: 'widget', content, widgetId: wid ?? input.messageId }, people, group, 'now')
    const reading = readDeliveryEnvelope(envelope)
    expect(reading?.segments[0]?.facts).toMatchObject({ messageId: 'msg:' + input.messageId, widgetId: wid ?? input.messageId })
    expect(reading?.body).toBe(content)
    const batch = readDeliveryEnvelope(mergeDeliveryEnvelopes([envelope, envelope]))
    expect(batch?.segments.map(segment => segment.facts?.widgetId)).toEqual([wid ?? input.messageId, wid ?? input.messageId])
  })

  it('uses the registry projection when the historical body names another widget', () => {
    const content = JSON.stringify({ ...spec, wid: 'another-origin' })
    const envelope = buildAgentDeliveryEnvelope({ ...input, contentType: 'widget', content, widgetId: input.messageId }, people, group, 'now')
    expect(readDeliveryEnvelope(envelope)?.segments[0]?.facts?.widgetId).toBe(input.messageId)
    const missing = buildAgentDeliveryEnvelope({ ...input, contentType: 'widget', content }, people, group, 'now')
    expect(missing).not.toContain('widget_id=')
  })

  it.each([
    ['text', JSON.stringify({ ...spec, wid: 'not-a-widget' })],
    ['widget', '{"id":"old","title":"Legacy"}'],
    ['widget', '{'],
  ])('does not invent an identity for %s content %s', (contentType, content) => {
    const envelope = buildAgentDeliveryEnvelope({ ...input, contentType, content }, people, group, 'now')
    expect(envelope).not.toContain('widget_id=')
    expect(readDeliveryEnvelope(envelope)?.segments[0]?.facts?.widgetId).toBeUndefined()
  })
})
