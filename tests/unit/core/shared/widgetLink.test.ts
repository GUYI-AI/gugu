import { describe, expect, it } from 'vitest'
import { guguLink, parseGuguLink, parseWidgetLink, widgetLink } from '@gugu/core/shared/ui/guguLink'

describe('stored widget links', () => {
  it.each(['bda1a92f-87ce-41d2-b337-25e41481bab8', 'legacy:Widget/界 #1?x=2', 'UPPER%id', ' spaced id '])('round trips a database text id as one URI component: %s', widgetId => {
    const href = widgetLink(widgetId)
    expect(href).toMatch(/^gugu-widget:\/\/[^/?#\s<>]+$/)
    expect(parseWidgetLink(href)).toEqual({ widgetId })
    expect(parseGuguLink(href)).toEqual({ kind: 'widget', widgetId })
    expect(guguLink({ kind: 'widget', widgetId })).toBe(href)
    expect(guguLink({ kind: 'widget', widgetId }, 'gugu-beta')).toBe(href)
  })
  it('encodes URI-safe punctuation that would change a bare Markdown link', () => {
    const widgetId = "*a* _b_ ~~c~~ (d) !'"
    const href = widgetLink(widgetId)
    expect(href).not.toMatch(/[!'()*_~]/)
    expect(parseWidgetLink(href)).toEqual({ widgetId })
  })
  it.each(['gugu-widget://', 'gugu-widget://id/another', 'gugu-widget://id?pin=1', 'gugu-widget://id#slot', 'gugu-widget://bad%xx', 'gugu-widget://%00', 'https://example.com/id'])('rejects malformed or extended references: %s', href => {
    expect(parseWidgetLink(href)).toBeNull()
  })
  it('rejects ids that cannot be a database text key', () => {
    expect(() => widgetLink('')).toThrow()
    expect(() => widgetLink('\0')).toThrow()
  })
})
