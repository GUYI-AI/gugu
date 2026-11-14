import { describe, expect, it } from 'vitest'
import { WidgetPresence, widgetPresenceOf } from '../../../apps/desktop/src/components/chat/widgetPresence'

const element = () => ({ scrollIntoView() {} }) as unknown as HTMLElement
const geometry = (bottom: number, ratio = 1) => ({ bottom, ratio, visible: ratio > 0 })

describe('one live widget per opened conversation', () => {
  it('keeps the current slot until a lower one is at least half visible, then retains the same owner on a small scroll back', () => {
    const presence = new WidgetPresence()
    const first = presence.register('w', element()), second = presence.register('w', element())
    presence.update(first, geometry(300))
    presence.update(second, geometry(600, 0.49))
    expect(presence.owners.get('w')).toBe(first)
    presence.update(second, geometry(600, 0.5))
    expect(presence.owners.get('w')).toBe(second)
    presence.update(second, geometry(600, 0.1))
    expect(presence.owners.get('w')).toBe(second)
    presence.update(second, geometry(600, 0))
    expect(presence.owners.get('w')).toBe(first)
  })

  it('settles an equal bottom on the earlier slot and does not let an old release remove the other', () => {
    const presence = new WidgetPresence()
    const first = presence.register('w', element()), second = presence.register('w', element())
    presence.update(second, geometry(300))
    presence.update(first, geometry(300))
    expect(presence.owners.get('w')).toBe(first)
    presence.release(second)
    expect(presence.owners.get('w')).toBe(first)
    presence.release(first)
    expect(presence.owners.has('w')).toBe(false)
  })

  it('shares one presence per chat, across the panels showing it, and keeps chats independent', () => {
    expect(widgetPresenceOf('chat-a')).toBe(widgetPresenceOf('chat-a'))
    const first = widgetPresenceOf('chat-a'), second = widgetPresenceOf('chat-b')
    const a = first.register('w', element()), b = second.register('w', element())
    first.update(a, geometry(300))
    second.update(b, geometry(600))
    first.release(a)
    expect(second.owners.get('w')).toBe(b)
    second.release(b)
  })

  it('preloads only the next lowest phone slot and never takes a visible owner away', () => {
    const presence = new WidgetPresence()
    const first = presence.register('w', element()), next = presence.register('w', element())
    presence.update(first, { ...geometry(1100, 0), nearby: true })
    presence.update(next, { ...geometry(1300, 0), nearby: true })
    expect(presence.owners.has('w')).toBe(false)
    expect(presence.preloads?.get('w')).toBe(next)
    presence.update(first, { ...geometry(900), nearby: true })
    expect(presence.owners.get('w')).toBe(first)
    expect(presence.preloads.has('w')).toBe(false)
    presence.update(first, { ...geometry(1100, 0), nearby: true })
    expect(presence.preloads.get('w')).toBe(next)
    presence.release(next)
    expect(presence.preloads.get('w')).toBe(first)
    presence.update(first, geometry(1800, 0))
    expect(presence.preloads.has('w')).toBe(false)
  })
})
