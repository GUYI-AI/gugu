// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { widgetPresenceOf } from './widgetPresence'

const el = () => document.createElement('div')

describe("a chat's widget presence", () => {
  it('is kept while a slot is registered and dropped with the last one', () => {
    const presence = widgetPresenceOf('presence-chat')
    const a = presence.register('w1', el())
    const b = presence.register('w2', el())
    presence.release(a)
    expect(widgetPresenceOf('presence-chat')).toBe(presence)
    presence.release(b)
    const next = widgetPresenceOf('presence-chat')
    expect(next).not.toBe(presence)
    // A late release on the dropped one leaves the chat's current presence alone.
    const kept = next.register('w1', el())
    presence.release(b)
    expect(widgetPresenceOf('presence-chat')).toBe(next)
    next.update(kept, { visible: true, ratio: 1, bottom: 10 })
    expect(next.owners.get('w1')).toBe(kept)
  })
})
