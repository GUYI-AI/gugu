import { describe, expect, it } from 'vitest'
import { mergeDeliveryEnvelopes, renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope'
import { timelineRailAdmits, timelineRailCandidates, timelineRailMessages, timelineRailPreviewText, type TimelineRailOptions } from '@gugu/core/shared/timelineRail'

const envelope = (overrides: Partial<Parameters<typeof renderDeliveryEnvelope>[0]> = {}) => renderDeliveryEnvelope({
  route: 'chat', from: 'Ada', fromId: 'user:ada', fromType: 'human', messageId: 'msg:one',
  at: '2026-11-03', chat: '7', chatKind: 'group', content: 'Human question', ...overrides,
})

describe('human timeline rail inputs', () => {
  it('keeps direct human input and the sender facts of delivered human messages', () => {
    expect(timelineRailMessages('  My question  ')).toEqual([{ text: 'My question', sender: null }])
    const [human] = timelineRailMessages(envelope())
    expect(human?.text).toBe('Human question')
    expect(human?.sender).toMatchObject({ from: 'Ada', fromId: 'user:ada', fromType: 'human', chatKind: 'group' })
  })

  it.each(['session-direct', 'system', 'scheduled'] as const)('excludes the %s route even with human-looking facts', (route) => {
    expect(timelineRailMessages(envelope({ route }))).toEqual([])
  })

  it('excludes agent chat deliveries even though agents have user: addresses', () => {
    expect(timelineRailMessages(envelope({ fromType: 'agent' }))).toEqual([])
    expect(timelineRailMessages(envelope({ fromType: 'agent' }), { selfUserId: 'ada' })).toEqual([])
  })

  it.each(['session:worker', 'agent:worker', 'system:gugu'])('excludes the non-human address %s', (fromId) => {
    expect(timelineRailMessages(envelope({ fromId }))).toEqual([])
  })

  it('resolves historical chat senders from real identity facts, including the signed-in person', () => {
    const legacy = envelope({ fromType: undefined })
    expect(timelineRailMessages(legacy)).toEqual([])
    expect(timelineRailMessages(legacy, { resolveSenderType: () => 'agent' })).toEqual([])
    expect(timelineRailMessages(legacy, { resolveSenderType: () => 'human' })[0]?.sender?.from).toBe('Ada')
    expect(timelineRailMessages(legacy, { selfUserId: 'ada' })).toHaveLength(1)
    expect(timelineRailMessages(legacy, { selfUserId: 'ada', resolveSenderType: () => 'agent' })).toEqual([])
  })

  it('keeps App interactions on behalf of the person, but not an explicitly identified agent', () => {
    expect(timelineRailMessages(envelope({ route: 'extension', fromId: 'extension:app', fromType: undefined }))).toHaveLength(1)
    expect(timelineRailMessages(envelope({ route: 'extension', fromType: 'agent' }))).toEqual([])
  })

  it('filters mixed batches by sender without losing other humans or exposing agent text', () => {
    const mixed = mergeDeliveryEnvelopes([
      envelope(), envelope({ fromType: 'agent', content: 'Agent-only secret' }),
      envelope({ from: 'Lin', fromId: 'user:lin', content: 'Second human' }),
      envelope({ route: 'scheduled', content: 'Timer-only secret' }),
    ])
    const humans = timelineRailMessages(mixed)
    expect(humans.map(({ text, sender }) => [text, sender?.from])).toEqual([
      ['Human question', 'Ada'], ['Second human', 'Lin'],
    ])
  })

  it('excludes empty and silence-only inputs and removes silence tokens from preview copy', () => {
    for (const text of ['', '  ', '[NO_REPLY]', ' \n[NO_REPLY]\n ']) expect(timelineRailMessages(text)).toEqual([])
    expect(timelineRailMessages(envelope({ content: '[NO_REPLY]' }))).toEqual([])
    expect(timelineRailPreviewText('Reply\n[NO_REPLY]')).toBe('Reply')
  })

  // A machine lists a conversation's candidates without a directory; each reader's own directory then admits them.
  // The two steps must come to what one reading with that directory comes to.
  it('admits from the candidates exactly the messages a single reading keeps', () => {
    const legacy = envelope({ fromType: undefined, from: 'Bo', fromId: 'user:bo' })
    const texts = ['  My question  ', '', '[NO_REPLY]', envelope(), envelope({ fromType: 'agent' }), envelope({ route: 'system' }),
      envelope({ route: 'session-direct' }), envelope({ fromId: 'session:worker' }), legacy,
      envelope({ route: 'extension', fromId: 'extension:app', fromType: undefined }), envelope({ route: 'extension', fromType: 'agent' }),
      mergeDeliveryEnvelopes([envelope(), envelope({ fromType: 'agent', content: 'Agent-only secret' }), legacy, envelope({ route: 'scheduled', content: 'Timer' })])]
    const readers: TimelineRailOptions[] = [{}, { selfUserId: 'bo' }, { resolveSenderType: () => 'human' }, { resolveSenderType: () => 'agent' },
      { selfUserId: 'bo', resolveSenderType: () => 'agent' }, { resolveSenderType: fromId => fromId === 'user:bo' ? 'human' : undefined }]
    for (const options of readers) for (const text of texts) {
      expect(timelineRailCandidates(text).filter(message => timelineRailAdmits(message, options))).toEqual(timelineRailMessages(text, options))
    }
    // What no directory could admit is not a candidate: an agent's text never leaves the machine as one.
    expect(timelineRailCandidates(envelope({ fromType: 'agent', content: 'Agent-only secret' }))).toEqual([])
    expect(timelineRailCandidates(legacy)).toHaveLength(1)
  })

  it('recognizes retired session-direct deliveries through the canonical reader', () => {
    const origin = { source: 'session-direct', sender_session_id: 'session:worker', message_id: 'msg:one', kind: 'message' }
    expect(timelineRailMessages(`[gugu_session session-direct]\norigin=${JSON.stringify(origin)}\nAgent work`)).toEqual([])
  })
})
