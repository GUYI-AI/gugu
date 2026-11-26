import { describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: { rpc }, getCurrentAuthUserId: async () => 'person-1' }))

import { currentGroupWebhooks, groupWebhookUrl, pickableTargets, type GroupWebhook } from '../../../../apps/desktop/src/lib/groupWebhooks'
import { isManagePage, webhookIdOf, webhookPage } from '../../../../apps/desktop/src/components/chat/useSettingsPages'

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
