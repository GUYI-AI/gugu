import { useEffect, useMemo } from 'react'
import { useReplica } from '../lib/replica'
import type { MemberProfileCardModel, MemberProfileEditControls } from '../components/MemberProfileCard'
import type { ActiveMemberProfile } from '../components/memberProfileModels'
import { useListenModeEditControls } from '../components/chat/useListenModeEditControls'
import { groupRoleRevision, useGroupChatSettings } from '../components/chat/useGroupChatSettings'
import { groupRoster } from './useRoomCollab'

/**
 * A message avatar can open its card in the main conversation or the topic pane.
 * A topic card reads its room's roster and writes its own membership row. Until
 * that roster confirms membership, the card only shows the agent's identity.
 */
export function useTopicScopedMemberProfile(opts: {
  profile: ActiveMemberProfile | null
  mainTopicChatId: string | null
  asideTopicChatId: string | null
  authorityRevision?: number
  currentUserId: string | null
  groupEditControlsFor: (profile: MemberProfileCardModel) => MemberProfileEditControls | undefined
}): { profile: ActiveMemberProfile; editControls: MemberProfileEditControls | undefined } | null {
  const { profile, mainTopicChatId, asideTopicChatId, currentUserId, groupEditControlsFor, authorityRevision = 0 } = opts
  const fromAside = profile?.openedFrom === 'aside'
  const topicChatId = (fromAside ? asideTopicChatId : mainTopicChatId) ?? null
  const roster = useReplica(groupRoster, topicChatId ? [topicChatId, 'topic'] : null)
  const load = () => topicChatId ? groupRoster.refresh(topicChatId) : Promise.resolve()

  const openedMemberId = profile?.member.id
  useEffect(() => { if (topicChatId && openedMemberId) void groupRoster.refresh(topicChatId) }, [topicChatId, openedMemberId])

  // A failed read, including lost participation, cannot confirm a topic membership.
  const topicSnapshot = roster.state === 'value' && !roster.error ? roster.value : null
  const { settings, reload } = useGroupChatSettings(topicChatId, topicSnapshot ? groupRoleRevision(topicSnapshot) : undefined, authorityRevision)
  const topicEditControlsFor = useListenModeEditControls({
    chatId: topicChatId,
    currentUserId,
    settings,
    onAuthorityReload: reload,
    onReload: load,
  })

  return useMemo(() => {
    if (!profile || (fromAside && !topicChatId)) return null
    if (!topicChatId) return { profile, editControls: groupEditControlsFor(profile.member) }
    const agent = topicSnapshot?.agents.find((a) => a.id === profile.member.id)
    const human = topicSnapshot?.humans.find((h) => h.id === profile.member.id)
    const member: MemberProfileCardModel = agent
      ? { ...profile.member, profileScope: 'group', membership: 'current', role: agent.role, listenMode: agent.listen_mode }
      : human
        ? { ...profile.member, profileScope: 'group', membership: 'current', role: human.role, listenMode: undefined }
        : { ...profile.member, profileScope: 'direct', listenMode: undefined }
    return { profile: { ...profile, member }, editControls: agent ? topicEditControlsFor(member) : undefined }
  }, [fromAside, groupEditControlsFor, profile, topicChatId, topicEditControlsFor, topicSnapshot])
}
