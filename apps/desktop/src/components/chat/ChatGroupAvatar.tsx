import { Avatar } from '../Avatar'
import { useChatStoreSelect } from '../../store/chatContext'

/**
 * #2600 A group's face wherever it is listed by id, a project's group included: the avatar its owner set, else the
 * usual group default face — never a generated folder in its place.
 */
export function ChatGroupAvatar({ chatId, name, size }: {
  chatId: string
  /** Shown while the chat is not in the list yet: the project's name. */
  name: string
  size: number
}) {
  const chat = useChatStoreSelect((store) => store.chats.find((row) => row.id === chatId))
  return (
    <Avatar
      name={chat?.name ?? name}
      avatarUrl={chat?.avatar}
      seed={chatId}
      size={size}
      variant="group"
    />
  )
}
