import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { MessageProvider } from '@gugu/session-ui/react/components'
import { Zap } from '@/lib/icons'
import { useLocale } from '@/i18n'
import { platform } from '@/platform'
import { useMobileShell } from '@/hooks/useMobileShell'
import { setComposerVerb } from '@/lib/composerVerbBridge'
import { UI_EVENTS } from '@/lib/uiEvents'
import { useChatStore } from '@/store/chatContext'
import { useTheme } from '@/store/theme'
import { SessionUiTheme } from '@/components/sessionpage/SessionUiTheme'
import { ComposerVerbDock } from '@renderer/features/sessions/task-dispatch-composer'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import type { ComposerAttachAction } from './ComposerAttachButton'

/** The task belongs to the topic whose composer opened it; no creation-time destination picker. */
export function TopicTaskEntry({ chatId, sourceChatId, topicName, attachMenu, children }: {
  chatId: string
  sourceChatId: string | null
  topicName: string
  attachMenu?: readonly ComposerAttachAction[]
  /** Keep the shared composer and its explicit prop contract at the conversation's call site. */
  children: (attachMenu: readonly ComposerAttachAction[] | undefined) => ReactNode
}) {
  const { t } = useTranslation('messaging')
  const mobile = useMobileShell()
  const { resolvedLocale } = useLocale()
  const { theme } = useTheme()
  const { chats, readDraft, writeDraft } = useChatStore('chats', 'readDraft', 'writeDraft')
  const source = chats.find(chat => chat.id === sourceChatId && chat.kind === 'group' && chat.status !== 'archived')
  const desktopHost = !mobile && platform.capabilities.sessionHost
  const enabled = (mobile || desktopHost) && !!source
  const action: ComposerAttachAction = {
    id: 'topic-new-task', label: t('composer.verb.task'), icon: <Zap size={14} />,
    onSelect: () => {
      if (!enabled || !source) return
      if (mobile) {
        window.dispatchEvent(new CustomEvent(UI_EVENTS.createAgentInGroup, {
          detail: { chatId: source.id, topic: { chatId, name: topicName } },
        }))
        return
      }
      const carry = readDraft(chatId)
      setComposerVerb(chatId, 'task', carry, { name: topicName, joinable: false, inGroup: true, birthChatId: source.id })
      if (carry.trim()) writeDraft(chatId, '')
    },
  }
  return <>
    {children(enabled ? [...(attachMenu ?? []), action] : attachMenu)}
    {desktopHost && <SessionUiTheme theme={theme}>
      <MessageProvider locale={resolvedLocale} translate={translateSessionMessage}>
        <ComposerVerbDock key={chatId} chatId={chatId} />
      </MessageProvider>
    </SessionUiTheme>}
  </>
}
