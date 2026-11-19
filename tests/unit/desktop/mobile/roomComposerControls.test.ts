import { describe, expect, it } from 'vitest'
import type { TopicSummary } from '@gugu/core/shared/types/chat'
import { chat } from '../../../support/testHarness'
import { roomAgentEntry, roomTopicChoices } from '../../../../apps/desktop/src/mobile/chat/room-composer-models'

const topic = (id: string): TopicSummary => ({ chat_id: id, name: 'Topic '+id, source_message_id: 'anchor-'+id,
  creator_user_id: 'owner', last_message_at: null, message_count: 0, participant_count: 1, is_participant: true })

const locator = (unread: number, addressed: number) => ({ stream_id: 's', stream_kind: 'main' as const, thread_root_id: null, message_id: null,
  message_seq: null, unread_count: unread, addressed_count: addressed, cursor_seq: 0, version: 1, is_marked_unread: false })
const room = (id: string, kind: 'group' | 'topic', unread: number, addressed: number, extra = {}) =>
  chat({ id, kind, unread_count: unread, unread_locator: unread > 0 ? locator(unread, addressed) : null, ...extra })
const marks = (r: ReturnType<typeof roomTopicChoices>) => r.topics.map(t => [t.chat_id, t.calls, t.news])

describe('phone room topic choices', () => {
  it('marks a topic that calls you with its call count and plain unread with the news dot (chat-list rule)', () => {
    const result = roomTopicChoices('room', [topic('plain'), topic('called'), topic('read')],
      [room('room', 'group', 7, 0), room('plain', 'topic', 4, 0), room('called', 'topic', 36, 1), room('read', 'topic', 0, 0)])
    expect(result.main).toEqual({ calls: 0, news: true })
    expect(marks(result)).toEqual([['called', 1, false], ['plain', 0, true], ['read', 0, false]])
    expect(result.dot).toBe('call')
  })
  it('lights the Topics control grey when nothing calls you, red when the main room calls you', () => {
    expect(roomTopicChoices('room', [topic('a')], [room('a', 'topic', 3, 0)]).dot).toBe('news')
    expect(roomTopicChoices('room', [topic('a')], [room('room', 'group', 2, 2), room('a', 'topic', 3, 0)]).dot).toBe('call')
  })
  it('keeps every visible topic even without a personal chat row', () => {
    const topics = [topic('a'), topic('b')]
    const result = roomTopicChoices('room', topics, [])
    expect(marks(result)).toEqual([['a', 0, false], ['b', 0, false]])
    expect(result.dot).toBeUndefined()
    expect(topics).toEqual([topic('a'), topic('b')])
  })
  it('shows a muted topic\'s calls like the chat list, without sorting it first', () => {
    const result = roomTopicChoices('room', [topic('muted'), topic('called')],
      [room('muted', 'topic', 12, 2, { is_muted: true }), room('called', 'topic', 1, 1)])
    expect(marks(result)).toEqual([['called', 1, false], ['muted', 2, false]])
  })
  it('removes the mark after the same projection reports the topics read', () => {
    const topics = [topic('a')]
    expect(roomTopicChoices('room', topics, [room('a', 'topic', 3, 1)]).dot).toBe('call')
    expect(roomTopicChoices('room', topics, [room('a', 'topic', 0, 0)]).dot).toBeUndefined()
  })
})

describe('phone room Agent entry permissions', () => {
  it.each([
    ['agent','owner','owner',true,'session'],
    ['agent','owner','owner',false,'profile'],
    ['agent','other','owner',true,'profile'],
    ['agent',null,'owner',true,'profile'],
    ['agent','owner',null,true,'profile'],
    ['human','owner','owner',true,'profile'],
  ] as const)('%s owned by %s with viewer %s and task %s opens %s', (type,ownerUserId,viewer,hasSession,expected) => {
    expect(roomAgentEntry({type,ownerUserId},viewer,hasSession)).toBe(expected)
  })
})
