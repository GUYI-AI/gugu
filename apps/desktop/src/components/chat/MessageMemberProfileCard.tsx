import { chatDisplayName } from '@gugu/core/shared/ui/chatModels'
import type { OpenTopic } from '../../hooks/useTopicSurface'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { useTopicScopedMemberProfile } from '../../hooks/useTopicScopedMemberProfile'
import { useActiveChatIdentity } from '../../store/chatContext'
import type { MemberProfileCardModel, MemberProfileChatTarget, MemberProfileEditControls } from '../MemberProfileCard'
import { MemberProfilePopover, MemberProfileRoot } from '../MemberProfilePopover'
import type { ActiveMemberProfile, MemberProfileHandle } from '../memberProfileModels'

type LayerProps = {
  card: MemberProfileHandle
  memberProfiles: Record<string, MemberProfileCardModel>
  authorityRevision: number
  asideTopic: OpenTopic | null
  chatId: string | null
  currentUserId: string | null
  isGroupChat: boolean
  groupEditControlsFor: (profile: MemberProfileCardModel) => MemberProfileEditControls | undefined
  onOpenUserChat?: (target: MemberProfileChatTarget) => void
  onWhisper: (target: MemberProfileChatTarget) => void
}

export function MessageMemberProfileLayer(props: LayerProps) {
  return (
    <MemberProfileRoot handle={props.card}>
      {(opened) => <MessageMemberProfileCard opened={opened} {...props} />}
    </MemberProfileRoot>
  )
}

/** The card a message avatar opened, refreshed from the roster and scoped to the topic it was opened in. */
function MessageMemberProfileCard({ opened, card, memberProfiles, authorityRevision, asideTopic, chatId, currentUserId, isGroupChat, groupEditControlsFor, onOpenUserChat, onWhisper }: LayerProps & { opened: ActiveMemberProfile }) {
  const latest = memberProfiles[opened.member.id]
  const profile = latest ? { ...opened, member: latest } : opened
  const mainChat = useActiveChatIdentity()
  const fromAside = opened.openedFrom === 'aside'
  const mainTopicChatId = mainChat?.kind === 'topic' ? mainChat.id : null
  const listenRoom = fromAside
    ? (asideTopic && { kind: 'topic' as const, name: asideTopic.name })
    : (mainChat?.kind === 'group' || mainChat?.kind === 'topic'
        ? { kind: mainChat.kind, name: chatDisplayName(mainChat, null) }
        : null)
  const shown = useTopicScopedMemberProfile({
    profile,
    authorityRevision,
    mainTopicChatId,
    asideTopicChatId: asideTopic?.chatId ?? null,
    currentUserId,
    groupEditControlsFor,
  })
  if (!shown) return null
  return (
    <MemberProfilePopover
      profile={shown.profile}
      // @@@5856 从话题分栏点开的卡片 ❌ 不给悄悄话:这个动作落在**主线**的输入框上,
      // 而用户此刻在看的是话题 —— 发出去会落进源群。要在话题里悄悄话,得先有话题自己的入口。
      onClose={() => card.close()}
      onOpenChat={shown.profile.member.id !== currentUserId && onOpenUserChat ? (target) => {
        card.close()
        onOpenUserChat(target)
      } : undefined}
      onWhisper={isGroupChat && shown.profile.openedFrom !== 'aside' ? (target) => {
        card.close()
        onWhisper(target)
      } : undefined}
      searchChatId={(fromAside ? asideTopic?.chatId : chatId) ?? undefined}
      listenRoom={listenRoom ?? undefined}
      editControls={shown.editControls}
      testId={AUTOMATION_TEST_IDS.messageAvatarProfileMenu}
    />
  )
}
