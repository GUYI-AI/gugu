import type { ContactGroupChat } from '@gugu/core/shared/types/contacts'
import { chatService } from './chat'
import { isGroupManagerRole } from './groupMemberPermissions'
import { pendingFirst } from './requestHistory'
import type { ManagedGroupJoinRequest } from './groupJoinRequestRow'

export type { ManagedGroupJoinRequest } from './groupJoinRequestRow'

/** 我能审的群 = 我是群主或管理员、且群还在。只用来判断「该重读了」(这组群变了);哪些申请归我审由服务端判。 */
export function managedGroupChats(groupChats: readonly ContactGroupChat[]): ContactGroupChat[] {
  return groupChats.filter((group) => isGroupManagerRole(group.my_role) && group.status !== 'archived')
}

/**
 * 读我管理的每个群的入群申请(含已处理的),等我处理的在前。一次读(list_managed_group_join_requests):
 * 哪些群归我管由服务端按同一道管理权限逐群判定,每行自带群名和头像 —— ❌ 再拿本地群列表筛一遍
 * (本地列表晚到或陈旧时会静默丢掉待审的申请,让管理员以为「没人申请」而漏审,#1125)。读失败整体 fail-loud。
 */
export async function listManagedGroupJoinRequests(): Promise<ManagedGroupJoinRequest[]> {
  return [...await chatService.listManagedGroupJoinRequests()].sort(pendingFirst)
}
