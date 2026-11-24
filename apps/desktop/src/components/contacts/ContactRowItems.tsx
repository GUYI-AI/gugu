import { groupDisplayName } from '@gugu/core/shared/ui/chatModels'
import type { ContactGroupChat, ContactUser } from '@gugu/core/shared/types/contacts'
import { useRowContextMenu } from '@/hooks/useRowContextMenu'
import { displayName } from '@/lib/contactsListSort'
import { Avatar } from '../Avatar'
import { AvatarUnread } from '../AvatarUnread'
import { ListRow } from '../ui/ListRow'
import { Chip } from '../ui/Chip'
import { Folder } from '@/lib/icons'
import { formatCalendarDay } from '@/i18n/format'
import type { GroupRowFacts } from './groupRowFacts'
import { ContactGroupAvatar, SelectionCheckbox } from './ContactSearch'
import { ContactRowContextMenu, type ContactRowMenuActions } from './ContactRowActions'
import { ct, rowAvatarClass, rowKeyActivate } from './contactsPanelStyles'
import { cn } from '@/lib/cn'

// 通讯录分组里的人 / 群行(原样从 ContactsPanel 搬出);分组页与搜索共用,动作由 ContactRows 的 useContactRowRenderers 给。

// ── PersonContactRow ──────────────────────────────────────────────────────────
export function PersonContactRow({
  contact,
  selected,
  multiSelected = false,
  selectionMode = false,
  pinned = false,
  onSelect,
  onToggleSelection,
  menu
}: {
  contact: ContactUser
  selected: boolean
  multiSelected?: boolean
  selectionMode?: boolean
  pinned?: boolean
  onSelect: () => void
  onToggleSelection?: () => void
  menu?: ContactRowMenuActions
}) {
  const { menuPos, onContextMenu, closeMenu } = useRowContextMenu()
  return (
    <>
      <ListRow
        role="button"
        tabIndex={0}
        data-contact-id={contact.id}
        data-contact-option={selectionMode ? contact.id : undefined}
        aria-pressed={selectionMode ? multiSelected : undefined}
        selected={selected}
        pinned={pinned}
        leading={
          <>
            {selectionMode ? <SelectionCheckbox checked={multiSelected} /> : null}
            <div className={rowAvatarClass}>
              <Avatar name={contact.display_name} avatarUrl={contact.avatar} seed={contact.id} size="sm" />
            </div>
          </>
        }
        title={displayName(contact)}
        onClick={() => (selectionMode ? onToggleSelection?.() : onSelect())}
        onKeyDown={rowKeyActivate(() => (selectionMode ? onToggleSelection?.() : onSelect()))}
        onContextMenu={menu ? onContextMenu : undefined}
      />
      {menu && menuPos ? (
        <ContactRowContextMenu x={menuPos.x} y={menuPos.y} onClose={closeMenu} {...menu} />
      ) : null}
    </>
  )
}

// ── GroupSectionRow ──────────────────────────────────────────────────────────
export function GroupSectionRow({
  group,
  selected,
  pinned = false,
  facts,
  onSelect,
  menu
}: {
  group: ContactGroupChat
  selected: boolean
  pinned?: boolean
  facts: GroupRowFacts
  onSelect: () => void
  menu?: ContactRowMenuActions
}) {
  const { menuPos, onContextMenu, closeMenu } = useRowContextMenu()
  return (
    <>
      <ListRow
        role="button"
        tabIndex={0}
        data-group-id={group.id}
        selected={selected}
        pinned={pinned}
        emphasis={facts.calls > 0 || facts.news}
        leading={<AvatarUnread calls={facts.calls} news={facts.news}><ContactGroupAvatar group={group} size="sm" /></AvatarUnread>}
        title={groupDisplayName(group)}
        accessory={facts.project ? <Chip className="gap-1"><Folder size={12} aria-hidden="true" />{facts.project.project.name}</Chip> : undefined}
        meta={facts.activityAt ? formatCalendarDay(facts.activityAt) : undefined}
        subtitle={<GroupMembersLine facts={facts} />}
        onClick={onSelect}
        onKeyDown={rowKeyActivate(onSelect)}
        onContextMenu={menu ? onContextMenu : undefined}
      />
      {menu && menuPos ? (
        <ContactRowContextMenu x={menuPos.x} y={menuPos.y} onClose={closeMenu} {...menu} />
      ) : null}
    </>
  )
}

// 群行第二行:前几位成员的头像(Agent 照常带 Agent 样式) + 「a 人 · b Agent」。
function GroupMembersLine({ facts }: { facts: GroupRowFacts }) {
  const counts = [facts.humans > 0 ? ct('groupRow.humans', { count: facts.humans }) : null, facts.agents > 0 ? ct('groupRow.agents', { count: facts.agents }) : null]
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <span className="inline-flex shrink-0">
        {facts.members.slice(0, 4).map((member, index) => (
          <span key={member.id} className={cn('inline-flex rounded-full ring-2 ring-[var(--bg)]', index > 0 && '-ml-1')}>
            <Avatar name={member.display_name} avatarUrl={member.avatar} seed={member.id} size="xs" isAgent={member.type === 'agent'} />
          </span>
        ))}
      </span>
      <span className="truncate">{counts.filter(Boolean).join(' · ')}</span>
    </span>
  )
}
