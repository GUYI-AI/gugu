import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/components/toastContext'
import { IconButton } from '@/components/ui/IconButton'
import { Pin, PinOff } from '@/lib/icons'
import { messageForUser } from '@/lib/userFacingError'
import { useChatStore } from '@/store/chatContext'
import { preserveComposerFocus } from '../composer/composer-focus'

export function PhoneTopicPinRow({ topic, children }: {
  topic: { chat_id: string; name: string; is_pinned?: boolean }
  children: ReactNode
}) {
  const { t } = useTranslation('mobileRoomControls')
  const { t: tm } = useTranslation('messaging')
  const { toast } = useToast()
  const { pinChat } = useChatStore('pinChat')
  const [pending, setPending] = useState(false)
  if (topic.is_pinned === undefined) return children

  const pinned = topic.is_pinned
  const label = t(pinned ? 'unpinTopic' : 'pinTopic', { name: topic.name })
  const toggle = async () => {
    setPending(true)
    try {
      await pinChat(topic.chat_id, !pinned)
    } catch (error) {
      toast(tm('chatArea.management.pinFailed', { reason: messageForUser(error) }), 'error')
    } finally {
      setPending(false)
    }
  }

  return <div className="gg-phone-room-topic-row">
    {children}
    <IconButton aria-label={label} title={label} on={pinned} disabled={pending}
      onPointerDown={preserveComposerFocus} onMouseDown={preserveComposerFocus} onClick={() => { void toggle() }}>
      {pinned ? <PinOff /> : <Pin />}
    </IconButton>
  </div>
}
