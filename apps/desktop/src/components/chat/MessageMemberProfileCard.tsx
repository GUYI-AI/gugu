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
  chatId: string | null
  currentUserId: string | null
  isRoomChat: boolean
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
function MessageMemberProfileCard({ opened, card, memberProfiles, authorityRevision, chatId, currentUserId, isRoomChat, groupEditControlsFor, onOpenUserChat, onWhisper }: LayerProps & { opened: ActiveMemberProfile }) {
  const latest = memberProfiles[opened.member.id]
  const profile = latest ? { ...opened, member: latest } : opened
  const mainChat = useActiveChatIdentity()
  const mainTopicChatId = mainChat?.kind === 'topic' ? mainChat.id : null
  const shown = useTopicScopedMemberProfile({
    profile,
    authorityRevision,
    mainTopicChatId,
    currentUserId,
    groupEditControlsFor,
  })
  if (!shown) return null
  return (
    <MemberProfilePopover
      profile={shown.profile}
      onClose={() => card.close()}
      onOpenChat={shown.profile.member.id !== currentUserId && onOpenUserChat ? (target) => {
        card.close()
        onOpenUserChat(target)
      } : undefined}
      onWhisper={isRoomChat ? (target) => {
        card.close()
        onWhisper(target)
      } : undefined}
      searchChatId={chatId ?? undefined}
      editControls={shown.editControls}
      testId={AUTOMATION_TEST_IDS.messageAvatarProfileMenu}
    />
  )
}
