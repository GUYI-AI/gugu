import { describe, expect, it } from 'vitest'
import { MESSAGES_VIEW_SELECT, messageItemFromRow } from '@gugu/core/cloud/messageItem'
import { buildThreadBootstrapBody } from '@gugu/core/local/agent/threadBootstrap'

const ROW = { id: 'm1', chat_id: 'g1', seq: 3, content: 'Deploy failed', content_type: 'text', to_user_ids: null, created_at: '2026-11-26T12:00:00Z' }

describe('a group webhook message (#3934)', () => {
  it('is read from messages_view with the webhook it came from', () => {
    expect(MESSAGES_VIEW_SELECT.split(', ')).toEqual(expect.arrayContaining(['via_webhook', 'via_webhook_name']))
    expect(messageItemFromRow({ ...ROW, sender_user_id: null, via_webhook: 'hook-1', via_webhook_name: 'Deploy alerts' }, 'me'))
      .toMatchObject({ sender_user_id: null, via_webhook: 'hook-1', via_webhook_name: 'Deploy alerts' })
  })

  it('only a sender-less row can be one; a closed account stays a closed account', () => {
    expect(messageItemFromRow({ ...ROW, sender_user_id: 'u1', via_webhook: 'hook-1', via_webhook_name: 'x' }, 'me'))
      .toMatchObject({ sender_user_id: 'u1', via_webhook: null, via_webhook_name: null })
    expect(messageItemFromRow({ ...ROW, sender_user_id: null, via_webhook: null, via_webhook_name: null }, 'me'))
      .toMatchObject({ sender_user_id: null, via_webhook: null })
  })

  it('a row from a backend before #420 (no webhook keys at all, e.g. a revision payload) maps as before', () => {
    const item = messageItemFromRow({ ...ROW, sender_user_id: 'u1' }, 'me')
    expect(item).toMatchObject({ sender_user_id: 'u1', via_webhook: null, via_webhook_name: null, content: 'Deploy failed' })
    expect(messageItemFromRow({ ...ROW, sender_user_id: null }, 'me')).toMatchObject({ sender_user_id: null, via_webhook: null })
  })

  it('in a thread it is told apart from any member, without an address', () => {
    const body = buildThreadBootstrapBody([
      { senderUserId: null, content: 'Deploy failed', createdAt: '2026-11-26T12:00:00Z' },
      { senderUserId: 'u1', content: 'looking', createdAt: '2026-11-26T12:01:00Z' },
    ], { selfAgentUserId: 'agent', labelFor: (id) => `user:${id}` })
    expect(body).toContain('no sender account (a notice or a webhook): Deploy failed')
    expect(body).toContain('user:u1: looking')
    expect(body).not.toContain('user:null')
  })
})
