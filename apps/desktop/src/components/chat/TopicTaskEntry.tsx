import { useTranslation } from 'react-i18next'
import { Zap } from '@/lib/icons'
import { platform } from '@/platform'
import { useMobileShell } from '@/hooks/useMobileShell'
import { setComposerVerb } from '@/lib/composerVerbBridge'
import { useChatStore } from '@/store/chatContext'
import { ComposerVerbDock } from '@renderer/features/sessions/task-dispatch-composer'
import { ChatMessageComposer } from './ChatMessageComposer'
import type { ChatMessageComposerProps } from './chatComposerModels'
import type { ComposerAttachAction } from './ComposerAttachButton'

/** The task belongs to the topic whose composer opened it; no creation-time destination picker. */
export function TopicTaskEntry({ sourceChatId, topicName, ...composer }: Omit<ChatMessageComposerProps, 'chatId'> & {
  chatId: string
  sourceChatId: string | null
  topicName: string
}) {
  const { t } = useTranslation('messaging')
  const mobile = useMobileShell()
  const { chats, readDraft, writeDraft } = useChatStore('chats', 'readDraft', 'writeDraft')
  const source = chats.find(chat => chat.id === sourceChatId && chat.kind === 'group' && chat.status !== 'archived')
  const desktopHost = !mobile && platform.capabilities.sessionHost
  const enabled = desktopHost && !!source
  const action: ComposerAttachAction = {
    id: 'topic-new-task', label: t('composer.verb.task'), icon: <Zap size={14} />,
    onSelect: () => {
      if (!enabled || !source) return
      const carry = readDraft(composer.chatId)
      setComposerVerb(composer.chatId, 'task', carry, { name: topicName, joinable: false, inGroup: true, birthChatId: source.id })
      if (carry.trim()) writeDraft(composer.chatId, '')
    },
  }
  return <>
    <ChatMessageComposer {...composer} attachMenu={enabled ? [...(composer.attachMenu ?? []), action] : composer.attachMenu} />
    {desktopHost && <ComposerVerbDock key={composer.chatId} chatId={composer.chatId} />}
  </>
}
