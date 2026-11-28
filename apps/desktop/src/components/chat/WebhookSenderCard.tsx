import { useTranslation } from 'react-i18next'
import { Button } from '../ui/Button'
import { Popover } from '../ui/Popover'
import { useChatStoreSelect } from '../../store/chatContext'
import { openInfoTab } from '../../session/renderer/features/chats/chat-tabs/chat-layouts'
import { WebhookAvatar } from './MessageSenderAvatar'
import { webhookPage } from './useSettingsPages'

// #3934 群里 Webhook 那条消息的名字:点开一张小卡,说清它不是成员、回它没人收到。群主/管理员多一个入口,直接到它的设置页。
const cardClass = 'gg-pop w-[284px] overflow-hidden rounded-xl bg-[var(--bg-elevated)] p-4 text-[var(--text-primary)] shadow-[var(--shadow-lift)]'

export function WebhookSenderName({ chatId, webhookId, name }: { chatId: string; webhookId: string; name: string }) {
  const { t } = useTranslation('messaging')
  const role = useChatStoreSelect((store) => store.chats.find((chat) => chat.id === chatId)?.my_role ?? null)
  return (
    <Popover.Root modal={false}>
      <Popover.Trigger className="msg-sender-name msg-sender-link" data-testid="message-webhook-name" onClick={(event) => event.stopPropagation()}>
        <span className="msg-sender-name">{name}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} collisionPadding={8}>
          <Popover.Popup aria-label={name} data-testid="message-webhook-card" className={cardClass}>
            <div className="flex items-center gap-3">
              <WebhookAvatar size={40} />
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-base font-semibold leading-snug">{name}</span>
                <span className="text-[length:var(--font-caption)] text-[var(--muted-fg)]">{t('message.webhookTag')}</span>
              </div>
            </div>
            <p className="mb-0 mt-3 leading-relaxed text-[var(--text-secondary)]">{t('message.webhookCardBody')}</p>
            {role === 'owner' || role === 'admin' ? (
              <Button variant="secondary" size="sm" className="mt-3 w-full" data-testid="message-webhook-manage"
                onClick={() => openInfoTab(chatId, webhookPage(webhookId))}>{t('message.webhookCardManage')}</Button>
            ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
