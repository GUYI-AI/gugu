import { describe, expect, it } from 'vitest'
import { messageItemFromRow } from '@gugu/core/cloud/messageItem'
import { optimisticReplyFields } from '@gugu/core/shared/ui/messageListModels'
import {
  deriveMessageSendState, deriveReadReceipt, isReadByRecipients, isReadByRecipientsPrecise, type MessageRecipientFacts,
} from '@gugu/core/shared/ui/messageState'

const source = messageItemFromRow({
  id: 'source', chat_id: 'group', sender_user_id: 'alice', seq: 1, content: 'hello',
}, 'sender')!
const members = { alice: 0, bob: 0, carol: 0 }
const memberIds = Object.keys(members)
const people: MessageRecipientFacts = { agentIds: new Set(), wakes: new Map() }

describe('reply and mention recipients share the read-receipt denominator', () => {
  it.each([
    { name: 'reply without mentions', reply: optimisticReplyFields([source], source.id), to: [], expected: ['alice'] },
    { name: 'reply and mention someone else', reply: optimisticReplyFields([source], source.id), to: ['bob'], expected: ['alice', 'bob'] },
    { name: 'reply and mention the same person', reply: optimisticReplyFields([source], source.id), to: ['alice', 'alice'], expected: ['alice'] },
    { name: 'reply to a whisper', reply: optimisticReplyFields([{ ...source, is_whisper: true }], source.id), to: [], expected: memberIds },
    { name: 'reply to a deleted message', reply: optimisticReplyFields([], source.id), to: [], expected: memberIds },
    { name: 'reply to a system message', reply: optimisticReplyFields([{ ...source, sender_user_id: null, content_type: 'system' }], source.id), to: [], expected: memberIds },
    { name: 'unresolved reply with a mention', reply: optimisticReplyFields([], source.id), to: ['bob'], expected: ['bob'] },
    { name: 'ordinary mention', reply: optimisticReplyFields([], null), to: ['bob'], expected: ['bob'] },
    { name: 'broadcast with null targets', reply: optimisticReplyFields([], null), to: null, expected: memberIds },
    { name: 'broadcast with empty targets', reply: optimisticReplyFields([], null), to: [], expected: memberIds },
    { name: 'broadcast sentinel overrides reply', reply: optimisticReplyFields([source], source.id), to: ['*'], expected: memberIds },
    { name: 'reply recipient has left', reply: optimisticReplyFields([{ ...source, sender_user_id: 'left' }], source.id), to: [], expected: [] },
    { name: 'reply to self excludes sender', reply: optimisticReplyFields([{ ...source, sender_user_id: 'sender' }], source.id), to: [], expected: [] },
  ])('$name', ({ reply, to, expected }) => {
    const message = { ...source, id: 'reply', sender_user_id: 'sender', seq: 10, delivered: true, ...reply, to_user_ids: to }
    expect(deriveReadReceipt(message, members, people)).toEqual({
      recipientIds: expected, totalRecipients: expected.length,
      readerIds: [], readCount: 0, unreadCount: expected.length,
    })

    // A partial recipient set must not turn the send state into read.
    for (const readIds of [expected.slice(0, -1), expected]) {
      const allRead = expected.length > 0 && readIds.length === expected.length
      const watermarks = Object.fromEntries(memberIds.map((id) => [id, readIds.includes(id) ? 10 : 0]))
      const messageReaders = { reply: new Set(readIds) }
      expect(isReadByRecipients(message, watermarks, people)).toBe(allRead)
      expect(isReadByRecipientsPrecise(message, memberIds, messageReaders, people)).toBe(allRead)
      expect(deriveMessageSendState(message, watermarks, people)).toBe(allRead ? 'read' : 'delivered')
      expect(deriveMessageSendState(message, members, people, { memberIds, messageReaders })).toBe(allRead ? 'read' : 'delivered')
      for (const receipt of [deriveReadReceipt(message, watermarks, people)!, deriveReadReceipt(message, members, people, { messageReaders })!]) {
        expect(receipt.recipientIds).toEqual(expected)
        expect(receipt.readerIds).toEqual(readIds)
        expect(receipt.unreadCount).toBe(expected.length - readIds.length)
      }
    }
  })
})

describe('agents count as recipients exactly when delivery woke them', () => {
  // alice is a person; active and passive are agents. Delivery decided wakes when each message was written.
  const seqs = { alice: 0, active: 0, passive: 0 }
  const agentIds = new Set(['active', 'passive'])
  const sent = (id: string, to: string[] | null) => ({ ...source, id, sender_user_id: 'sender', seq: 10, delivered: true, to_user_ids: to })
  const facts = (wakes: Record<string, string[]>): MessageRecipientFacts =>
    ({ agentIds, wakes: new Map(Object.entries(wakes).map(([id, agents]) => [id, new Set(agents)])) })

  it.each([
    { name: 'undirected: people and the active agent, not the passive one', to: null, woken: ['active'], expected: ['alice', 'active'] },
    { name: 'mentioning the passive agent', to: ['passive'], woken: ['passive'], expected: ['passive'] },
    { name: '@all wakes both agents', to: ['*'], woken: ['active', 'passive'], expected: ['alice', 'active', 'passive'] },
    { name: 'an agent woken by nothing (agent-sent or quiet notification level) is not waited on', to: null, woken: [], expected: ['alice'] },
  ])('$name', ({ to, woken, expected }) => {
    const message = sent('m', to)
    expect(deriveReadReceipt(message, seqs, facts({ m: woken }))?.recipientIds).toEqual(expected)
    // Everyone delivered to has read it ⇒ read, whatever the never-delivered passive agent's watermark says.
    const read = Object.fromEntries(Object.keys(seqs).map((id) => [id, expected.includes(id) ? 10 : 0]))
    expect(deriveMessageSendState(message, read, facts({ m: woken }))).toBe('read')
  })

  it('keeps a refused agent (delivery block) in the recipients, like any addressed agent', () => {
    const message = { ...sent('m', ['passive']), delivery_blocks: [{ agent_user_id: 'passive', reason: 'agent_archived' }] }
    expect(deriveReadReceipt(message, seqs, facts({ m: [] }))?.recipientIds).toEqual(['passive'])
  })

  it('says nothing until the wakes are known, and does not wait for them in a chat with no agents', () => {
    const message = sent('m', null)
    expect(deriveReadReceipt(message, seqs, facts({}))).toBeNull()
    expect(deriveMessageSendState(message, { alice: 10, active: 10, passive: 10 }, facts({}))).toBe('delivered')
    expect(deriveReadReceipt(message, { alice: 0 }, facts({}))?.recipientIds).toEqual(['alice'])
  })
})
