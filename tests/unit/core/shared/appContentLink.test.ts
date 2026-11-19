import { describe, expect, it } from 'vitest'
import { guguLink, parseGuguLink } from '@gugu/core/shared/ui/guguLink'

describe('App content link query fields', () => {
  it.each(['gugu', 'gugu-beta', 'gugu-dev'])('round-trips App-owned query keys in %s', (scheme) => {
    const query = JSON.parse('{"__proto__":"own value","constructor":"label","sheet":"R&D"}') as Record<string, string>
    const target = { kind: 'app' as const, extensionId: 'kanban', tab: 'main', path: 'card/3', query, place: { chat: 'chat-1' } }
    const parsed = parseGuguLink(guguLink(target, scheme))
    expect(parsed).toEqual(target)
    if (parsed?.kind !== 'app') throw new Error('Expected an App content link')
    expect(Object.hasOwn(parsed.query, '__proto__')).toBe(true)
    expect(parsed.query.__proto__).toBe('own value')
    expect(parsed.query).not.toHaveProperty('gugu.chat')
  })

  it('keeps the last repeated value and excludes reserved context fields', () => {
    expect(parseGuguLink('gugu://ext/kanban/main?sheet=one&sheet=two&gugu.session=task-1&gugu.other=hidden')).toEqual({
      kind: 'app', extensionId: 'kanban', tab: 'main', path: '', query: { sheet: 'two' }, place: { session: 'task-1' },
    })
  })
})
