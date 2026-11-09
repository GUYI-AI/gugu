// @vitest-environment jsdom
// #2383:@ 过、后来退群的人只被消息的收件人引用 —— 补身份和「已不在群」的资料都要算上他,收件人行才有名字。
import { describe, expect, it } from 'vitest'
import { messageReferencedUserIds } from '../../../../apps/desktop/src/lib/messageReferencedUserIds'
import { buildMemberProfileMap } from '../../../../apps/desktop/src/components/memberProfileModels'
import { EMPTY_GROUP_COLLAB } from '../../../../apps/desktop/src/hooks/useGroupCollabLoader'
import type { DisplayIdentity } from '../../../../apps/desktop/src/lib/displayIdentity'

function identity(id: string, display_name: string): DisplayIdentity {
  return {
    id, type: 'agent', display_name, nameSerial: null, avatar: null, gugu_number: null, bio: null,
    owner_user_id: null, agent_public: null, desired_status: null, device_id: null,
    category: null, is_official: null, local_path: null,
    created_at: null, updated_at: '2026-11-09T00:00:00.000Z',
  }
}

describe('messageReferencedUserIds (#2383)', () => {
  it('lists senders, replied-to senders and addressed recipients, but not @所有人', () => {
    expect(messageReferencedUserIds([
      { sender_user_id: 'me', reply_to_sender_user_id: 'quoted', to_user_ids: ['left-agent', '*'] },
      { sender_user_id: null, reply_to_sender_user_id: null, to_user_ids: null },
    ])).toEqual(['me', 'quoted', 'left-agent'])
  })

  it('gives an addressed member who has left the group a former profile, so the recipient line has a name', () => {
    const profiles = buildMemberProfileMap(
      EMPTY_GROUP_COLLAB,
      { 'left-agent': identity('left-agent', '已归档 Agent') },
      {},
      [{ sender_user_id: 'me', reply_to_sender_user_id: null, to_user_ids: ['left-agent'] }],
    )
    expect(profiles['left-agent']).toMatchObject({ displayName: '已归档 Agent', membership: 'former' })
  })
})
