// @vitest-environment jsdom
//
// @@@6418 跨群读取入群申请。判据:一次读,哪些群归我审由服务端判,每行自带它的群;等我处理的在前;
// 读失败整体失败(少读一个群 = 管理员以为没人申请)。「我能审的群」只用来判断该不该重读。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chatService } from '../../../apps/desktop/src/lib/chat'
import { listManagedGroupJoinRequests, managedGroupChats } from '../../../apps/desktop/src/lib/groupJoinRequests'
import { managedJoinRequestFromRow } from '../../../apps/desktop/src/lib/groupJoinRequestRow'
import type { ContactGroupChat } from '../../../packages/core/src/shared/types/contacts'

afterEach(() => { vi.restoreAllMocks() })

function group(id: string, my_role: ContactGroupChat['my_role'], status: ContactGroupChat['status'] = 'active'): ContactGroupChat {
  return { id, kind: 'group', name: `群-${id}`, avatar_url: null, status, member_count: 3, is_muted: false, my_role }
}
function row(id: string, chat_id: string, created_at: string, status = 'pending') {
  return { id, chat_id, chat_name: `群-${chat_id}`, chat_avatar_url: null, requester_user_id: `u-${id}`, requester_name: `人-${id}`,
    requester_avatar: null, message: null, status, created_at, requester_type: 'human', requested_by_user_id: null }
}

describe('#6418 managedGroupChats (the re-read trigger)', () => {
  it('只留我是群主/管理员、且没解散的群', () => {
    const groups = [group('a', 'owner'), group('b', 'admin'), group('c', 'member'), group('d', null), group('e', 'owner', 'archived')]
    expect(managedGroupChats(groups).map((g) => g.id)).toEqual(['a', 'b'])
  })
})

describe('#6418 listManagedGroupJoinRequests', () => {
  it('一次读;每行带上服务端给的群名和头像;等我处理的在前、新的在前', async () => {
    const list = vi.spyOn(chatService, 'listManagedGroupJoinRequests').mockResolvedValue([
      managedJoinRequestFromRow(row('r1', 'a', '2026-09-24T01:00:00Z')),
      managedJoinRequestFromRow(row('r0', 'a', '2026-09-24T04:00:00Z', 'accepted')),
      managedJoinRequestFromRow(row('r2', 'b', '2026-09-24T02:00:00Z')),
    ])
    const rows = await listManagedGroupJoinRequests()
    expect(list).toHaveBeenCalledTimes(1)
    expect(rows.map((r) => r.id)).toEqual(['r2', 'r1', 'r0'])
    expect(rows[0].group).toEqual({ id: 'b', name: '群-b', avatar_url: null })
  })

  it('a group missing from the local list still shows its pending request (the server decides what I manage)', async () => {
    vi.spyOn(chatService, 'listManagedGroupJoinRequests').mockResolvedValue([managedJoinRequestFromRow(row('r9', 'not-in-local-list', '2026-09-24T03:00:00Z'))])
    expect((await listManagedGroupJoinRequests()).map((r) => [r.id, r.group.name])).toEqual([['r9', '群-not-in-local-list']])
  })

  it('读失败就整体失败', async () => {
    vi.spyOn(chatService, 'listManagedGroupJoinRequests').mockRejectedValue(new Error('network down'))
    await expect(listManagedGroupJoinRequests()).rejects.toThrow('network down')
  })
})
