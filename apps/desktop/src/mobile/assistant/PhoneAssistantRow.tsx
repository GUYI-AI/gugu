import { useTranslation } from 'react-i18next'
import { chatActivityAt, chatAttention } from '@gugu/core/shared/ui/chatModels'
import { Avatar } from '@/components/Avatar'
import { AvatarUnread } from '@/components/AvatarUnread'
import { chatLineNews } from '@/lib/chatLineUnread'
import { ListRow } from '@/components/ui/ListRow'
import { chatPreviewText } from '@/lib/systemNoticeText'
import { AUTOMATION_TEST_IDS } from '@/lib/automationDom'
import { formatCalendarDay } from '@/i18n/format'
import { useChatStore } from '@/store/chatContext'
import { PhoneGuguTabIcon } from './PhoneGuguTabIcon'
import type { PhoneAssistantState } from './usePhoneAssistant'

/**
 * 「消息」置顶的第一行:咕咕(owner 10-26:「咕咕不单独弄一个界面了,成为会话首个」),点它整屏推进咕咕页。
 * 和别的会话行同一个 ListRow:头像、名字、它最后一句、时间、未读;它那条私聊不再另占一行。
 * 还没有它(新用户)也在这一行,点进去是给它安家的引导。没有长按菜单:它不能被删、置顶或免打扰。
 */
export function PhoneAssistantRow({ state, onOpen }: { state: PhoneAssistantState; onOpen: () => void }) {
  const { t } = useTranslation('assistant')
  const { chats } = useChatStore('chats')
  const chat = state.chatId ? chats.find((candidate) => candidate.id === state.chatId) : undefined
  const contact = state.assistant
  const name = contact?.display_name ?? t('rail')
  // 同会话行一个口径(AvatarUnread):叫到你的数,其余新消息一个灰点;私聊每一条都叫到你。
  const calls = chat ? chatAttention(chat).callsYou : 0
  const news = !!chat && chatLineNews(chat, calls)
  return (
    <ListRow
      mobile
      data-first-run-hint="assistant"
      data-first-run-device="phone"
      role="option"
      aria-selected={false}
      data-testid={AUTOMATION_TEST_IDS.mobileAssistantNav}
      emphasis={calls > 0 || news}
      onClick={onOpen}
      leading={<AvatarUnread calls={calls} news={news}>{contact
        ? <Avatar name={name} avatarUrl={contact.avatar} seed={contact.id} size={48} isAgent />
        : <PhoneGuguTabIcon name={name} fresh={state.stage.stage === 'onboarding'} />}</AvatarUnread>}
      title={name}
      meta={chat ? formatCalendarDay(chatActivityAt(chat)) : undefined}
      subtitle={chat ? chatPreviewText(chat) : undefined}
    />
  )
}
