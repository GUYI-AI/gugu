import { beforeEach, describe, expect, it } from 'vitest'
import { parseSystemNotice } from '../../../../packages/core/src/shared/ui/systemNotice'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n'
import { chatPreviewText, systemNoticeText } from '../../../../apps/desktop/src/lib/systemNoticeText'

const row = (client_message_id: string, content: string, sender_user_id: string | null = null) => ({
  id: 'm1', content_type: 'system' as const, sender_user_id, client_message_id, content,
})
const text = (message: ReturnType<typeof row>) => systemNoticeText(parseSystemNotice(message), message.content)

// The rows exactly as gugu-supabase writes them: Chinese content plus a marker. No stored row is ever rewritten.
const ROWS = [
  [row('agent-flood:m1', '这个群里 agent 较多,已把它们都转为被动模式,@ 它们才会回。'),
    'This group has many agents, so they now reply only when @-mentioned.',
    '这个群里 agent 较多，已把它们都转为被动模式，@ 它们才会回。'],
  [row('agent-flood:m1', '这条话题里 agent 较多,已把它们都转为被动模式,@ 它们才会回。'),
    'This topic has many agents, so they now reply only when @-mentioned.',
    '这条话题里 agent 较多，已把它们都转为被动模式，@ 它们才会回。'],
  [row('member-joined:m1:u1,u2', 'Leo Park、小林 加入了群聊'), 'Leo Park, 小林 joined the group', 'Leo Park、小林 加入了群聊'],
  [row('member-managed:m1:u1,u1', 'Leo Park 退出了群聊'), 'Leo Park left the group', 'Leo Park 退出了群聊'],
  [row('member-managed:m1:u1,u2', 'Ann 将 Leo Park 移出了群聊'), 'Ann removed Leo Park from the group', 'Ann 将 Leo Park 移出了群聊'],
  [row('member-managed:m1:u1,u2', 'Ann 将 Leo Park 设为管理员'), 'Ann made Leo Park an admin', 'Ann 将 Leo Park 设为管理员'],
  [row('member-managed:m1:u1,u2', 'Ann 撤销了 Leo Park 的管理员身份'), 'Ann removed Leo Park as an admin', 'Ann 撤销了 Leo Park 的管理员身份'],
  [row('topic-opened:t1', 'Claude 开了话题:Launch plan', 'u1'), 'Claude opened a topic: Launch plan', 'Claude 开了话题：Launch plan'],
] as const

describe('system rows in the reader language', () => {
  describe('en-US', () => {
    beforeEach(() => setLocalePreference('en-US'))
    it.each(ROWS)('%s', (message, en) => expect(text(message)).toBe(en))
    it('the chat list says it from the same preview, and does not read names as markdown', () => {
      expect(chatPreviewText({ last_message_preview: 'A*b* 退出了群聊', last_message_notice: { kind: 'member-managed' } })).toBe('A*b* left the group')
    })
    it('a preview cut before its tail keeps the names', () => {
      expect(systemNoticeText({ kind: 'member-joined', userIds: ['u1'] }, 'Leo')).toBe('Leo joined the group')
    })
  })

  describe('zh-CN', () => {
    beforeEach(() => setLocalePreference('zh-CN'))
    it.each(ROWS)('%s', (message, _en, zh) => expect(text(message)).toBe(zh))
  })

  it('a sentence it does not know stays as written, and so does a row without a marker', () => {
    expect(text(row('member-managed:m1:u1,u2', '别的写法'))).toBe('别的写法')
    expect(text(row('', '没有标记的系统行'))).toBe('没有标记的系统行')
  })

  it('someone else\'s message cannot pass for a server row', () => {
    expect(parseSystemNotice(row('agent-flood:other', 'x'))).toBeNull()
    expect(parseSystemNotice(row('member-managed:other:u1', 'x'))).toBeNull()
    expect(parseSystemNotice(row('agent-flood:m1', 'x', 'u1'))).toBeNull()
  })
})
