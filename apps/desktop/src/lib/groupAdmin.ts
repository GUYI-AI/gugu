import { createGroupAdmin } from '@gugu/core/cloud/groupAdmin'
import { i18n } from '@/i18n'
import { chatDb, getCurrentAuthUserId } from './supabase'

export async function currentGroupAdmin() {
  return createGroupAdmin(chatDb, await getCurrentAuthUserId())
}

/**
 * The owner hands the group to a human member and becomes an admin (gugu-supabase chat.transfer_group_owner_as).
 * A backend without that RPC answers PostgREST PGRST202: say the server cannot do it yet, never pretend it happened.
 */
export async function transferGroupOwner(chatId: string, newOwnerUserId: string): Promise<void> {
  try {
    await (await currentGroupAdmin()).transferOwner(chatId, newOwnerUserId)
  } catch (error) {
    const reason = (error as { code?: unknown; message?: unknown } | null)
    const key = reason?.code === 'PGRST202' ? 'group.memberList.transferOwnerUnavailable'
      : reason?.message === 'project_group_transfer_unsupported' ? 'group.memberList.transferOwnerProjectGroup' : null
    if (key) throw new Error(i18n.t(key, { ns: 'messaging' }), { cause: error })
    throw error
  }
}
