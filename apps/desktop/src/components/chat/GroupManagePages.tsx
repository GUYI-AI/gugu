import type { CSSProperties, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { GroupChatSettings, UpdateGroupChatSettingsInput } from '@gugu/core/shared/types/chat'
import { GroupSettingsManagePage } from './GroupSettingsManagePage'
import { GroupWebhookDetail, GroupWebhookList } from './GroupWebhookPages'
import { useGroupWebhooks } from './useGroupWebhooks'
import type { WebhookMember } from '../../lib/groupWebhooks'
import { webhookIdOf, webhookPage, type ManagePage } from './useSettingsPages'

/**
 * 群管理和它下面的页(#3934 Webhook 列表、每个 Webhook)。只有群主/管理员进得来;Webhook 名单三页共读一份。
 * 从 GroupMembersSection 拆出来:那个文件行数冻结。
 */
export function GroupManagePages({ page, chatId, settings, members, totalMembers, onUpdate, head, bodyStyle, errorLine, push, pop }: {
  page: ManagePage
  chatId: string
  /** The group's current members, the ones a webhook can point at. */
  members: readonly WebhookMember[]
  settings: GroupChatSettings
  totalMembers: number | null
  onUpdate: (input: UpdateGroupChatSettingsInput) => Promise<boolean>
  head: (title: ReactNode, action?: ReactNode) => ReactNode
  bodyStyle: CSSProperties
  errorLine: ReactNode
  push: (page: ManagePage) => void
  pop: () => void
}) {
  const { t } = useTranslation('messaging')
  const webhooks = useGroupWebhooks(chatId)
  if (page === 'webhooks') return <GroupWebhookList webhooks={webhooks} members={members} head={head} bodyStyle={bodyStyle} onOpen={(id) => push(webhookPage(id))} />
  const webhookId = webhookIdOf(page)
  if (webhookId) return <GroupWebhookDetail webhooks={webhooks} members={members} webhookId={webhookId} head={head} bodyStyle={bodyStyle} onDeleted={pop} />
  return (
    <>
      {head(t('group.settings.manage'))}
      <div style={bodyStyle}>
        <GroupSettingsManagePage chatId={chatId} settings={settings} totalMembers={totalMembers} onUpdate={onUpdate}
          webhookCount={webhooks.hooks?.length ?? null} onOpenWebhooks={() => push('webhooks')} />
        {errorLine}
      </div>
    </>
  )
}
