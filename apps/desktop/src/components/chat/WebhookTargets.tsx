import type { KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { Avatar } from '../Avatar'
import { SelectionCheckbox } from '../contacts/ContactSearch'
import { Button } from '../ui/Button'
import { ListRow } from '../ui/ListRow'
import { useChatStore } from '../../store/chatContext'
import { GROUP_WEBHOOK_TARGET_MAX, type GroupWebhook, type WebhookMember } from '../../lib/groupWebhooks'

// #3934 Webhook 的「指向」(owner 11-26 21:28):建时设、存在 Webhook 上,可选;调地址的一方改不了。
// 只能选本群现在的成员(人或 agent),最多 20 位;已退群的指向灰着标「已退群」,全退了发来的消息会被拒收(409)。

const listClass = '-mx-2 max-h-[280px] overflow-y-auto'
const captionClass = 'text-[length:var(--font-caption)] leading-[var(--lh-caption)] text-[var(--muted-fg)]'

/** The group's current members to pick from; picking stops at GROUP_WEBHOOK_TARGET_MAX. */
export function WebhookTargetChecklist({ members, selected, onChange }: {
  members: readonly WebhookMember[]
  selected: readonly string[]
  onChange: (next: string[]) => void
}) {
  const { t } = useTranslation('messaging')
  const { identitiesById } = useChatStore('identitiesById')
  const full = selected.length >= GROUP_WEBHOOK_TARGET_MAX
  const toggle = (id: string) => {
    if (selected.includes(id)) onChange(selected.filter((entry) => entry !== id))
    else if (!full) onChange([...selected, id])
  }
  return (
    <>
      <div role="listbox" aria-multiselectable="true" aria-label={t('group.webhooks.targets')} className={listClass} data-testid="group-webhook-targets-list">
        {members.map((member) => {
          const checked = selected.includes(member.id)
          const locked = !checked && full
          const identity = identitiesById[member.id]
          const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); toggle(member.id) }
          }
          return (
            <ListRow key={member.id} role="option" aria-selected={checked} aria-disabled={locked || undefined} tabIndex={0}
              data-webhook-target-option={member.id} className={cn(locked && 'opacity-60')}
              leading={<>
                <SelectionCheckbox checked={checked} />
                <Avatar name={identity?.display_name ?? ''} avatarUrl={identity?.avatar ?? null} seed={member.id} size="sm" isAgent={member.type === 'agent'} />
              </>}
              title={identity?.display_name ?? ''}
              meta={member.type === 'agent' ? t('group.webhooks.agentTag') : undefined}
              onClick={() => toggle(member.id)} onKeyDown={onKeyDown} />
          )
        })}
      </div>
      {full ? <div className={captionClass}>{t('group.webhooks.targetsLimit', { max: GROUP_WEBHOOK_TARGET_MAX })}</div> : null}
    </>
  )
}

/** A webhook's page: who its messages point at, with the way to change it. */
export function WebhookTargetsSummary({ hook, members, onEdit }: { hook: GroupWebhook; members: readonly WebhookMember[]; onEdit: () => void }) {
  const { t } = useTranslation('messaging')
  const { identitiesById } = useChatStore('identitiesById')
  const present = new Set(members.map((member) => member.id))
  const allLeft = hook.targetUserIds.length > 0 && hook.targetUserIds.every((id) => !present.has(id))
  return (
    <div data-testid="group-webhook-targets">
      <div className="flex items-start gap-3 py-2">
        <div className="min-w-0 flex-1">
          {hook.targetUserIds.length === 0 ? (
            <div className="font-medium">{t('group.webhooks.targetsNone')}</div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {hook.targetUserIds.map((id) => {
                const identity = identitiesById[id]
                const left = !present.has(id)
                return (
                  <span key={id} data-webhook-target={id} data-left={left || undefined}
                    className={cn('inline-flex min-w-0 max-w-full items-center gap-2 rounded-full bg-[var(--bubble-own)] py-1 pl-1 pr-3', left && 'opacity-60')}>
                    <Avatar name={identity?.display_name ?? ''} avatarUrl={identity?.avatar ?? null} seed={id} size="xs" isAgent={identity ? identity.type === 'agent' : undefined} />
                    <span className="truncate">{identity?.display_name ?? ''}</span>
                    {left ? <span className={captionClass}>{t('group.webhooks.targetLeft')}</span> : null}
                  </span>
                )
              })}
            </div>
          )}
        </div>
        <Button variant="secondary" size="sm" data-testid="group-webhook-targets-edit" onClick={onEdit}>{t('group.webhooks.targetsEdit')}</Button>
      </div>
      {allLeft ? <div role="alert" className={cn(captionClass, 'mb-1 text-[var(--danger-fg)]')}>{t('group.webhooks.targetsAllLeft')}</div> : null}
      <div className={captionClass}>{t('group.webhooks.targetsHint')}</div>
    </div>
  )
}
