import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: { rpc }, getCurrentAuthUserId: async () => 'owner' }))

import { setLocalePreference } from '../../../../apps/desktop/src/i18n'
import { transferGroupOwner } from '../../../../apps/desktop/src/lib/groupAdmin'

describe('transferGroupOwner', () => {
  beforeEach(() => { rpc.mockReset(); setLocalePreference('en-US') })

  it('resolves only on the database receipt for that owner', async () => {
    rpc.mockResolvedValue({ data: { chat_id: 'group', owner_user_id: 'heir' }, error: null })
    await transferGroupOwner('group', 'heir')
    expect(rpc).toHaveBeenCalledWith('transfer_group_owner_as', { p_chat_id: 'group', p_new_owner_user_id: 'heir', p_as_user_id: 'owner' })
  })

  it('an older backend without the RPC says so in the reader language instead of pretending', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function chat.transfer_group_owner_as' } })
    await expect(transferGroupOwner('group', 'heir')).rejects.toThrow('The server does not support transferring group ownership yet.')
    setLocalePreference('zh-CN')
    await expect(transferGroupOwner('group', 'heir')).rejects.toThrow('服务端尚不支持转让群主')
  })

  it('explains the project-group refusal and passes other refusals through unchanged', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'project_group_transfer_unsupported' } })
    await expect(transferGroupOwner('group', 'heir')).rejects.toThrow("A project group's owner is the project's owner")
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'group_owner_required' } })
    await expect(transferGroupOwner('group', 'heir')).rejects.toThrow('group_owner_required')
  })
})
