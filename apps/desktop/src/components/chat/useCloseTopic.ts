import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../store/chatContext'
import { confirmConversationAction } from '../../lib/confirmDanger'
import { messageForUser } from '../../lib/userFacingError'
import { useToast } from '../toastContext'

export function useCloseTopic() {
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const { deleteChat } = useChatStore('deleteChat')

  return (topicId: string, name: string, onClosed?: () => void) => {
    void confirmConversationAction('delete-chat', 'topic', name).then((ok) => {
      if (ok) void deleteChat(topicId, true).then(onClosed, (failure: unknown) => {
        toast(t('chatList.deleteFailed'), 'error', messageForUser(failure))
      })
    })
  }
}
