import { describe, expect, it, vi } from 'vitest'
import { createGroupWebhooks, groupWebhookFromRow, groupWebhookUrl } from '../../../../packages/core/src/cloud/groupWebhooks'

const ROW = {
  id: 'hook-1', chat_id: 'group-1', name: 'Deploy alerts', token: 'ggwh_' + 'a'.repeat(40), target_user_ids: ['member-1', 'agent-1'],
  created_by: 'owner', created_by_name: 'Ada', created_at: '2026-11-26T12:00:00Z', disabled_at: null, last_used_at: null,
}
const client = (data: unknown = [ROW], error: { code?: string; message: string } | null = null) => {
  const rpc = vi.fn(async () => ({ data, error }))
  return { rpc }
}

describe('group webhooks, shared by the app and the gugu MCP server (#3934)', () => {
  it('reads every column the six functions return, and refuses a row without its token, name or targets', () => {
    expect(groupWebhookFromRow(ROW)).toEqual({
      id: 'hook-1', chatId: 'group-1', name: 'Deploy alerts', token: ROW.token, targetUserIds: ['member-1', 'agent-1'],
      createdBy: 'owner', createdByName: 'Ada', createdAt: ROW.created_at, disabledAt: null, lastUsedAt: null,
    })
    expect(groupWebhookFromRow({ ...ROW, target_user_ids: [] }).targetUserIds).toEqual([])
    for (const broken of [{ token: null }, { name: '' }, { target_user_ids: null }, { target_user_ids: ['member-1', ''] }]) {
      expect(() => groupWebhookFromRow({ ...ROW, ...broken }), JSON.stringify(broken)).toThrow('incomplete row')
    }
  })

  it('addresses the group-webhook function of the given backend', () => {
    expect(groupWebhookUrl('https://db.example.test/', 'ggwh_x')).toBe('https://db.example.test/functions/v1/group-webhook/ggwh_x')
  })

  it('acts as the given actor in every call; each function gets its own arguments', async () => {
    const transport = client()
    const hooks = createGroupWebhooks(transport, 'agent-admin')
    await expect(hooks.list('group-1')).resolves.toHaveLength(1)
    await hooks.create('group-1', 'Deploy alerts', ['member-1'])
    await hooks.update('hook-1', { name: 'CI' })
    await hooks.update('hook-1', { targetUserIds: [] })
    await hooks.setDisabled('hook-1', true)
    await hooks.rotate('hook-1')
    await hooks.remove('hook-1')
    const as = { p_as_user_id: 'agent-admin' }
    expect(transport.rpc.mock.calls).toEqual([
      ['group_webhooks_list', { p_chat_id: 'group-1', ...as }],
      ['group_webhook_create', { p_chat_id: 'group-1', p_name: 'Deploy alerts', p_target_user_ids: ['member-1'], ...as }],
      ['group_webhook_update', { p_webhook_id: 'hook-1', p_name: 'CI', p_target_user_ids: null, ...as }],
      ['group_webhook_update', { p_webhook_id: 'hook-1', p_name: null, p_target_user_ids: [], ...as }],
      ['group_webhook_set_disabled', { p_webhook_id: 'hook-1', p_disabled: true, ...as }],
      ['group_webhook_rotate', { p_webhook_id: 'hook-1', ...as }],
      ['group_webhook_delete', { p_webhook_id: 'hook-1', ...as }],
    ])
    expect(() => createGroupWebhooks(transport, ' ')).toThrow('explicit actor')
  })

  it('passes the refusal through with its SQLSTATE, and refuses a change that names no webhook', async () => {
    await expect(createGroupWebhooks(client(null, { code: '42501', message: 'group_manager_required' }), 'a').rotate('hook-1'))
      .rejects.toMatchObject({ message: 'group_manager_required', code: '42501' })
    await expect(createGroupWebhooks(client([]), 'a').rotate('hook-1')).rejects.toThrow('returned 0 rows')
  })
})
