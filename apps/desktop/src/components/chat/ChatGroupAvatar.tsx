import { Avatar } from '../Avatar'
import { useChatStore, useChatStoreSelect } from '../../store/chatContext'

/**
 * #2600 A group's face wherever it is listed by id, a project's group included: the avatar its owner set, else the
 * usual group default (its members' avatars) — never a generated folder in its place.
 */
export function ChatGroupAvatar({ chatId, name, size }: {
  chatId: string
  /** Shown while the chat is not in the list yet: the project's name. */
  name: string
  size: number
}) {
  const chat = useChatStoreSelect((store) => store.chats.find((row) => row.id === chatId))
  const { identitiesById } = useChatStore('identitiesById')
  return (
    <Avatar
      name={chat?.name ?? name}
      avatarUrl={chat?.avatar}
      seed={chatId}
      size={size}
      variant="group"
      harnessBadge={false}
      memberAvatars={chat?.member_user_ids?.flatMap((id) => {
        const identity = identitiesById[id]
        return identity ? [{ id, name: identity.display_name, avatar: identity.avatar }] : []
      })}
    />
  )
}
