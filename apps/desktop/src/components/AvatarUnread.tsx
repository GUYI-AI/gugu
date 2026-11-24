import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Chip } from './ui/Chip'

/**
 * A conversation row's unread mark, always on its avatar's top-right corner (owner 11-24): a red count of what calls you
 * (chatLineCalls — a direct message, a mention, a reply to you), otherwise a grey dot when there is other news. The
 * bottom-right corner is the agent's status mark (Avatar). Every row that shows unread draws it through here.
 */
export function AvatarUnread({ calls, news, children }: { calls: number; news: boolean; children: ReactNode }) {
  const { t } = useTranslation('messaging')
  return (
    <span className="gg-avatar-unread">
      {children}
      {calls > 0 ? (
        <Chip tone="danger" shape="count" className="gg-avatar-unread-mark">{calls > 99 ? '99+' : calls}</Chip>
      ) : news ? (
        <Chip shape="dot" role="img" aria-label={t('chatList.newsNotCallingYou')} title={t('chatList.newsNotCallingYou')} className="gg-avatar-unread-mark" />
      ) : null}
    </span>
  )
}
