import { withSourceLineCandidates, type GroupRosterCandidate } from '@/lib/mention'

type TopicIdentity = { display_name: string; owner_user_id?: string | null; gugu_number?: number | null; type: 'human' | 'agent' }

/**
 * 话题里能 @ 的人 = 来源线名册 ∪ 来源线 member_user_ids ∪ **话题自己的成员**。
 * owner 3a:从前话题成员只拿来排序,不在来源线名册里的话题成员(名册还没到、或已离开来源线)
 * 就 @ 不到。身份解析不出名字的照旧不进(名字是投递依据,见 withSourceLineCandidates)。
 */
export function topicMentionCandidates(
  sourceRoster: GroupRosterCandidate[],
  sourceMemberUserIds: readonly string[] | null | undefined,
  topicMemberUserIds: readonly string[] | null | undefined,
  identities: Readonly<Record<string, TopicIdentity>>,
): GroupRosterCandidate[] {
  const withSource = withSourceLineCandidates(sourceRoster, sourceMemberUserIds, identities)
  return withSourceLineCandidates(withSource, topicMemberUserIds, identities)
}
