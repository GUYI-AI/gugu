import { describe, expect, it } from 'vitest'
import type { TopicSummary } from '@gugu/core/shared/types/chat'
import { chat } from '../../../support/testHarness'
import { roomAgentEntry, roomTopicChoices } from '../../../../apps/desktop/src/mobile/chat/room-composer-models'

const topic = (id: string): TopicSummary => ({ chat_id: id, name: 'Topic '+id, source_message_id: 'anchor-'+id,
  creator_user_id: 'owner', last_message_at: null, message_count: 0, participant_count: 1, is_participant: true })

describe('phone room topic choices', () => {
  it('reads main and topic unread counts from the existing chat projection', () => {
    const result=roomTopicChoices('room',[topic('a'),topic('b')],[chat({id:'room',kind:'group',unread_count:7}),chat({id:'a',kind:'topic',unread_count:4})])
    expect(result.mainUnread).toBe(7)
    expect(result.unreadCount).toBe(11)
    expect(result.topics.map(t=>[t.chat_id,t.unread])).toEqual([['a',4],['b',0]])
    expect(result.hasUnread).toBe(true)
  })
  it('keeps every visible topic even without a personal chat row', () => {
    const topics=[topic('a'),topic('b')]
    const result=roomTopicChoices('room',topics,[])
    expect(result.topics.map(t=>t.chat_id)).toEqual(['a','b'])
    expect(result.hasUnread).toBe(false)
    expect(result.unreadCount).toBe(0)
    expect(topics).toEqual([topic('a'),topic('b')])
  })
  it('keeps unread counts for muted topics without promoting their calls', () => {
    const result=roomTopicChoices('room',[topic('muted'),topic('called')],[chat({id:'muted',kind:'topic',unread_count:12,is_muted:true}),chat({id:'called',kind:'topic',unread_count:1})])
    expect(result.topics.map(t=>[t.chat_id,t.unread])).toEqual([['called',1],['muted',12]])
    expect(result.hasUnread).toBe(true)
  })
  it('removes the dot after the same projection reports the topics read', () => {
    const topics=[topic('a')]
    expect(roomTopicChoices('room',topics,[chat({id:'a',kind:'topic',unread_count:3})]).hasUnread).toBe(true)
    expect(roomTopicChoices('room',topics,[chat({id:'a',kind:'topic',unread_count:0})]).hasUnread).toBe(false)
  })
  it('keeps the main-room unread marker when there are no topics', () => {
    expect(roomTopicChoices('room',[],[chat({id:'room',kind:'group',unread_count:1})])).toEqual({mainUnread:1,unreadCount:1,topics:[],hasUnread:true})
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
