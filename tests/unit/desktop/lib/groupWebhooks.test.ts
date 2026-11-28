import { describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: { rpc }, getCurrentAuthUserId: async () => 'person-1' }))

import { currentGroupWebhooks, groupWebhookUrl, pickableTargets, type GroupWebhook } from '../../../../apps/desktop/src/lib/groupWebhooks'
import { isManagePage, webhookIdOf, webhookPage } from '../../../../apps/desktop/src/components/chat/useSettingsPages'
import { parseSystemNotice } from '../../../../packages/core/src/shared/ui/systemNotice'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n'
import { systemNoticeText } from '../../../../apps/desktop/src/lib/systemNoticeText'

describe('group webhooks in the app (#3934)', () => {
  it('acts as the signed-in person', async () => {
    rpc.mockResolvedValue({ data: [], error: null })
    await (await currentGroupWebhooks()).list('group-1')
    expect(rpc).toHaveBeenCalledWith('group_webhooks_list', { p_chat_id: 'group-1', p_as_user_id: 'person-1' })
  })

  it('posts to the group-webhook function of the configured backend', () => {
    vi.stubEnv('GUGU_SUPABASE_URL', 'https://db.example.test/')
    try {
      expect(groupWebhookUrl('ggwh_x')).toBe('https://db.example.test/functions/v1/group-webhook/ggwh_x')
    } finally { vi.unstubAllEnvs() }
  })

  it('the target picker starts from the targets still in the group, in their order', () => {
    const hook = { targetUserIds: ['left-1', 'agent-2', 'person-3'] } as GroupWebhook
    expect(pickableTargets(hook, [{ id: 'person-3', type: 'human' }, { id: 'agent-2', type: 'agent' }])).toEqual(['agent-2', 'person-3'])
  })

  it('a webhook page sits under the group management and its list', () => {
    expect(webhookIdOf(webhookPage('hook-1'))).toBe('hook-1')
    expect(webhookIdOf('manage')).toBeNull()
    expect(['manage', 'webhooks', 'webhook:hook-1', 'members', 'main'].map((page) => isManagePage(page as never))).toEqual([true, true, true, false, false])
  })
})

describe('the server notice when a webhook changes, in the reader language (#3934)', () => {
  // chat_private.announce_group_webhook writes one Chinese sentence and marks it webhook-changed:<message id>:<actor>.
  const notice = (content: string, id = 'm1', marker = `webhook-changed:${id}:u1`) =>
    ({ id, content_type: 'system' as const, sender_user_id: null, client_message_id: marker, content })
  const say = (row: ReturnType<typeof notice>) => systemNoticeText(parseSystemNotice(row), row.content)

  it('says each of the four sentences in English and keeps the Chinese ones as written', () => {
    const rows = [
      ['Ann 添加了 Webhook「CI 告警」', 'Ann added the webhook “CI 告警”'],
      ['Ann 停用了 Webhook「CI 告警」', 'Ann disabled the webhook “CI 告警”'],
      ['Ann 重新启用了 Webhook「CI 告警」', 'Ann enabled the webhook “CI 告警” again'],
      ['Ann 删除了 Webhook「CI 告警」', 'Ann deleted the webhook “CI 告警”'],
    ] as const
    setLocalePreference('en-US')
    for (const [content, english] of rows) expect(say(notice(content))).toBe(english)
    setLocalePreference('zh-CN')
    for (const [content] of rows) expect(say(notice(content))).toBe(content)
  })

  it('leaves a sentence it does not know, or a row whose marker is not its own, as written', () => {
    setLocalePreference('en-US')
    expect(say(notice('Ann 改名了 Webhook「CI 告警」'))).toBe('Ann 改名了 Webhook「CI 告警」')
    expect(parseSystemNotice(notice('Ann 添加了 Webhook「CI 告警」', 'm1', 'webhook-changed:other:u1'))).toBeNull()
  })
})
