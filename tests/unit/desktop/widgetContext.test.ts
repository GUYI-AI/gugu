import { describe, expect, it } from 'vitest'
import { sameWidgetIdentity, widgetContext } from '../../../apps/desktop/src/session/shared/extensions/widget-context'
import { EXTENSION_WIDGET_IDENTITY_API_VERSION } from '../../../apps/desktop/src/session/shared/extensions/bridge-protocol'

const widget = { id: 'widget', originMessageId: 'origin', messageId: 'reference', senderId: 'author', data: { count: 1 } }
describe('widget context compatibility and immutable instance identity', () => {
  it('keeps the origin projection for older Apps and gives the new contract the active slot', () => {
    expect(widgetContext(widget, EXTENSION_WIDGET_IDENTITY_API_VERSION - 1))
      .toEqual({ messageId: 'origin', sender: 'author', data: { count: 1 } })
    expect(widgetContext(widget, EXTENSION_WIDGET_IDENTITY_API_VERSION))
      .toEqual({ id: 'widget', originMessageId: 'origin', messageId: 'reference', sender: 'author', data: { count: 1 } })
  })
  it('allows changing only the visible slot, retaining the author and input', () => {
    expect(sameWidgetIdentity(widget, { ...widget, messageId: 'another reference' })).toBe(true)
    for (const change of [{ id: 'other' }, { originMessageId: 'other' }, { senderId: 'other' }, { data: { count: 2 } }]) {
      expect(sameWidgetIdentity(widget, { ...widget, ...change })).toBe(false)
    }
    expect(sameWidgetIdentity(undefined, widget)).toBe(false)
    expect(sameWidgetIdentity({ messageId: 'legacy', data: {}, senderId: null }, { messageId: 'legacy', data: {}, senderId: null })).toBe(false)
  })
})
