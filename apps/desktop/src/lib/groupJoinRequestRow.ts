import type { GroupJoinRequest } from '@gugu/core/shared/types/chat'
import type { ContactGroupChat } from '@gugu/core/shared/types/contacts'
import { resolveOrLoud } from '@gugu/core/shared/resolveOrLoud'

/**
 * @@@6418 入群申请(#858)是冲着「人」来的请求 —— 和好友申请一样归通讯录「新的请求」,❌ 折叠在群里。
 * 一条申请带上它要进的那个群,卡片上才说得清「谁想进哪个群」;群名和头像由服务端同一行带回。
 */
export type ManagedGroupJoinRequest = GroupJoinRequest & {
  requester_name?: string
  requester_avatar?: string | null
  group: Pick<ContactGroupChat, 'id' | 'name' | 'avatar_url'>
}

/** One row of list_managed_group_join_requests as the client's join request, with the group it asks to join. */
export function managedJoinRequestFromRow(row: unknown): ManagedGroupJoinRequest {
  const r = row as {
    id: string
    chat_id: string
    chat_name: string | null
    chat_avatar_url: string | null
    requester_user_id: string
    requester_name: string | null
    requester_avatar: string | null
    message: string | null
    status: string
    created_at: string | null
    requester_type?: string | null; requested_by_user_id?: string | null
  }
  return {
    id: r.id,
    chat_id: r.chat_id,
    requester_user_id: r.requester_user_id,
    requester_type: r.requester_type === 'agent' ? 'agent' as const : 'human' as const, requested_by_user_id: r.requested_by_user_id ?? null,
    requester_name: resolveOrLoud(r.requester_name, `friend-request requester ${r.requester_user_id ?? r.chat_id}`),
    requester_avatar: r.requester_avatar ?? null,
    message: r.message ?? null,
    status: r.status === 'accepted' || r.status === 'rejected' ? r.status : 'pending',
    created_at: r.created_at ?? null,
    group: { id: r.chat_id, name: r.chat_name ?? '', avatar_url: r.chat_avatar_url ?? null },
  }
}
