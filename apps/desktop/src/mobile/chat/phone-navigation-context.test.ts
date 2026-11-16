import { expect, it } from 'vitest'
import { matchesPhoneNavigationLabel, phoneAgentHeaderName, phoneTopicHeader } from './phone-navigation-context'

it('filters labels without replacing duplicate-name topic identities', () => {
  const rows = [{ chat_id: 'topic-a', name: 'Design' }, { chat_id: 'topic-b', name: 'Design' }]
  const shown = rows.filter(row => matchesPhoneNavigationLabel(row.name, ' design '))
  expect(shown).toEqual(rows)
  expect(shown[0]).toBe(rows[0])
  expect(shown[1]).toBe(rows[1])
  expect(matchesPhoneNavigationLabel('设计讨论', '讨论')).toBe(true)
  expect(matchesPhoneNavigationLabel('Design', 'absent')).toBe(false)
})

it('follows a topic ID and its live rename, then returns to the source context', () => {
  const room = { id: 'source', name: 'Room' }
  const topics = [{ chat_id: 'a', name: 'Same' }, { chat_id: 'b', name: 'Renamed B' }]
  expect(phoneTopicHeader(room, { chatId: 'b', name: 'Same' }, topics)).toEqual({ kind: 'topic', id: 'b', name: 'Renamed B' })
  expect(phoneTopicHeader(room, { chatId: 'a', name: 'Same' }, topics)).toEqual({ kind: 'topic', id: 'a', name: 'Same' })
  expect(phoneTopicHeader(room, null, topics)).toEqual({ kind: 'chat', id: 'source', name: 'Room' })
})

it('retains the selected topic identity while its live summary is pending', () => {
  expect(phoneTopicHeader({ id: 'room', name: 'Room' }, { chatId: 'new-topic', name: 'New topic' }, []))
    .toEqual({ kind: 'topic', id: 'new-topic', name: 'New topic' })
})

it('uses the current Agent identity name and keeps the new-session fallback', () => {
  expect(phoneAgentHeaderName('First prompt', 'Current Agent')).toBe('Current Agent')
  expect(phoneAgentHeaderName('New Agent', null)).toBe('New Agent')
  expect(phoneAgentHeaderName('New Agent', '  ')).toBe('New Agent')
})
