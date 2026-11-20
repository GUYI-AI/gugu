import { groupDisplayName } from '@gugu/core/shared/ui/chatModels'
import type { ContactGroupChat, ContactUser } from '@gugu/core/shared/types/contacts'
import { useRowContextMenu } from '@/hooks/useRowContextMenu'
import { displayName } from '@/lib/contactsListSort'
import { Avatar } from '../Avatar'
import { ListRow } from '../ui/ListRow'
import { ContactGroupAvatar, SelectionCheckbox } from './ContactSearch'
import { ContactRowContextMenu, type ContactRowMenuActions } from './ContactRowActions'
import { ct, rowAvatarClass, rowKeyActivate } from './contactsPanelStyles'

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
  onSelect,
  menu
}: {
  group: ContactGroupChat
  selected: boolean
  pinned?: boolean
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
        leading={<ContactGroupAvatar group={group} size="sm" />}
        title={groupDisplayName(group)}
        /* show member count like design's group row .st-dot.off — 静态灰点(非 agent 态),用 offline 档 */
        meta={ct('panel.memberCount', { count: group.member_count })}
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
