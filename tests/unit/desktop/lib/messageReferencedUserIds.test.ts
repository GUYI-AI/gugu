// @vitest-environment jsdom
// #2383:@ 过、后来退群的人只被消息的收件人引用 —— 补身份和「已不在群」的资料都要算上他,收件人行才有名字。
import { describe, expect, it } from 'vitest'
import { messageReferencedUserIds } from '../../../../apps/desktop/src/lib/messageReferencedUserIds'
import { buildMemberProfileMap } from '../../../../apps/desktop/src/components/memberProfileModels'
import type { GroupCollabSnapshot } from '@gugu/core/shared/types/chat'
import type { DisplayIdentity } from '../../../../apps/desktop/src/lib/displayIdentity'

function identity(id: string, display_name: string): DisplayIdentity {
  return {
    id, type: 'agent', display_name, avatar: null, gugu_number: null, bio: null,
    owner_user_id: null, agent_public: null, desired_status: null, device_id: null,
    category: null, is_official: null, local_path: null,
    created_at: null, updated_at: '2026-11-09T00:00:00.000Z',
  }
}

const noMembers: GroupCollabSnapshot = {
  scheduler: { chat_id: 'group-1', paused: false, queue_count: 0, blocked_count: 0, summary: null, updated_at: new Date(0).toISOString() },
  humans: [], agents: [], tasks: [],
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
      noMembers,
      { 'left-agent': identity('left-agent', '已归档 Agent') },
      {},
      [{ sender_user_id: 'me', reply_to_sender_user_id: null, to_user_ids: ['left-agent'] }],
    )
    expect(profiles['left-agent']).toMatchObject({ displayName: '已归档 Agent', membership: 'former' })
  })

  it('before the roster is read, nobody is taken for a former member', () => {
    const profiles = buildMemberProfileMap(
      null,
      { speaker: identity('speaker', 'Speaker') },
      {},
      [{ sender_user_id: 'speaker', reply_to_sender_user_id: null, to_user_ids: null }],
    )
    expect(profiles.speaker).toMatchObject({ displayName: 'Speaker', membership: 'unknown' })
  })
})
