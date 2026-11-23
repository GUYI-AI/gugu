import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Bell, ChevronRight, Info, Pencil } from '@/lib/icons'
import { InlineNameInput } from '../ui/InlineNameInput'
import { Switch } from '../ui/Switch'
import { menuSurfaceClassName } from '../ui/Menu'

/** One row of the card: the icon, its words, what sits at its end. */
export interface ConversationCardRow {
  icon: ReactNode
  label: string
  end?: ReactNode
  testId?: string
  run: () => void
}

/**
 * The conversation's card (第 16 版「名片」): what clicking the conversation's name opens, the same for my agent, a
 * person and a group. Name (click to rename, ❌ a harness mark before it), one line under it, 消息通知, one action of its
 * own kind (an agent restarts, a group or topic searches its history), then 「详情 ›」 into the side panel's 详情 tab.
 * Only draws: every row is the existing action its caller passes in.
 */
export function ConversationCard({ avatar, name, subtitle, onRename, notify, action, onDetails }: {
  avatar: ReactNode
  name: string
  subtitle?: ReactNode
  /** null = this viewer cannot rename it: the name is plain text. */
  onRename: ((next: string) => Promise<void>) | null
  /** null = it has no notification setting here. */
  notify: { on: boolean; set: (on: boolean) => void } | null
  action: ConversationCardRow | null
  onDetails: () => void
}) {
  const { t } = useTranslation('messaging')
  const [editing, setEditing] = useState(false)
  return (
    <div data-testid="conversation-card" className={`${menuSurfaceClassName} w-[300px] p-1.5`}>
      <div className="flex items-center gap-3 px-2.5 pt-2.5 pb-3">
        <span className="flex shrink-0">{avatar}</span>
        <div className="min-w-0 flex-1">
          {editing && onRename
            ? <InlineNameInput name={name} onCommit={onRename} onClose={() => setEditing(false)} testId="conversation-card-name-input" />
            : <button type="button" data-testid="conversation-card-name" disabled={!onRename} title={onRename ? t('conversationCard.rename') : undefined}
              onClick={() => setEditing(true)}
              className="-ms-1 flex max-w-full min-w-0 items-center gap-1.5 rounded-md px-1 text-left text-[15px] leading-[22px] font-semibold enabled:cursor-text enabled:hover:bg-row-hover">
              <span className="truncate">{name}</span>
              {onRename ? <Pencil size={13} className="shrink-0 text-[var(--faint-fg)]" /> : null}
            </button>}
          {subtitle ? <div className="flex min-w-0 items-center gap-1.5 truncate text-[12.5px] leading-[18px] text-[var(--muted-fg)]">{subtitle}</div> : null}
        </div>
      </div>
      {notify ? <CardRow icon={<Bell size={16} />} label={t('conversationCard.notifications')} testId="conversation-card-notify" run={() => notify.set(!notify.on)}
        end={<Switch checked={notify.on} onCheckedChange={notify.set} onClick={(event) => event.stopPropagation()} aria-label={t('conversationCard.notifications')} />} /> : null}
      {action ? <CardRow {...action} /> : null}
      <div className="mx-2.5 my-1 h-px bg-[var(--border)]" />
      <CardRow icon={<Info size={16} />} label={t('conversationCard.details')} testId="conversation-card-details" run={onDetails} end={<ChevronRight size={14} />} />
    </div>
  )
}

function CardRow({ icon, label, end, testId, run }: ConversationCardRow) {
  return (
    <div role="button" tabIndex={0} data-testid={testId} onClick={run}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); run() } }}
      className="flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] hover:bg-row-hover">
      <span className="flex shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {end ? <span className="ms-auto flex items-center gap-1 text-[12.5px] text-[var(--faint-fg)]">{end}</span> : null}
    </div>
  )
}
