import { describe, expect, it } from 'vitest'
import { foldDeliveryEnvelope, mergeDeliveryEnvelopes, readDeliveryEnvelope, renderDeliveryEnvelope, type DeliveryEnvelopeFacts } from './deliveryEnvelope'

const AGENT = 'user:11111111-1111-4111-8111-111111111111'
const facts = (over: Record<string, unknown> = {}) => ({
  route: 'chat', from: 'd3', fromId: AGENT, fromType: 'agent', chat: '216009', chatKind: 'group',
  messageId: 'msg:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', at: '2026-11-11T10:00:00Z', listenMode: 'active',
  content: 'b'.repeat(500), threadContext: 't'.repeat(300), messageContext: 'm'.repeat(300),
  replyTo: { messageId: 'msg:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', fromId: 'user:22222222-2222-4222-8222-222222222222', from: 'Owner', preview: 'p'.repeat(100) },
  ...over,
}) as unknown as DeliveryEnvelopeFacts

// A reader that reads a delivery again when its exchange is opened is sent this form of it (transport-trim `folded-form`).
describe('a delivery as a folded exchange carries it', () => {
  it('keeps every fact of the opening tag and which message it answered, cuts the body, and drops the contexts', () => {
    const whole = renderDeliveryEnvelope(facts())
    const folded = foldDeliveryEnvelope(whole, 120)!
    expect(folded.length).toBeLessThan(whole.length / 2)
    const before = readDeliveryEnvelope(whole)!.segments[0]!, after = readDeliveryEnvelope(folded)!.segments[0]!
    expect(after.body).toBe('b'.repeat(120))
    expect(after.facts).toEqual({ ...before.facts, threadContext: null, messageContext: null, replyTo: { ...before.facts!.replyTo!, preview: '' } })
    expect(folded).not.toContain('<arrival>')
  })

  it('leaves a short body as it is, and a body that ends in a CDATA close readable', () => {
    const short = foldDeliveryEnvelope(renderDeliveryEnvelope(facts({ content: 'done', replyTo: undefined })), 120)!
    expect(readDeliveryEnvelope(short)!.segments[0]!.body).toBe('done')
    const tricky = foldDeliveryEnvelope(renderDeliveryEnvelope(facts({ content: `${'x'.repeat(117)}]]>tail` })), 120)!
    expect(readDeliveryEnvelope(tricky)!.segments[0]!.body).toBe(`${'x'.repeat(117)}]]>`)
  })

  it('folds each delivery of a batch, in order', () => {
    const second = facts({ from: 'd4', fromId: 'user:33333333-3333-4333-8333-333333333333', messageId: 'msg:cccccccc-cccc-4ccc-8ccc-cccccccccccc', content: 'c'.repeat(400) })
    const folded = foldDeliveryEnvelope(mergeDeliveryEnvelopes([renderDeliveryEnvelope(facts()), renderDeliveryEnvelope(second)]), 120)!
    const read = readDeliveryEnvelope(folded)!
    expect(read.segments.map(part => [part.facts!.fromId, part.facts!.messageId, part.body.length])).toEqual([
      [AGENT, 'msg:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 120], ['user:33333333-3333-4333-8333-333333333333', 'msg:cccccccc-cccc-4ccc-8ccc-cccccccccccc', 120]])
  })

  it('answers null for what is not the current envelope syntax: those stay whole', () => {
    expect(foldDeliveryEnvelope('hello', 120)).toBeNull()
    expect(foldDeliveryEnvelope('<gugu_delivery route="chat">not closed', 120)).toBeNull()
    expect(foldDeliveryEnvelope('[gugu_session session-direct]\norigin={}\nbody', 120)).toBeNull()
  })
})
