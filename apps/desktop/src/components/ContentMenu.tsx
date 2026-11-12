import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, FileText, Reply } from '@/lib/icons'
import { formatHotkeyText } from '@/session/renderer/lib/ui/shortcut-format'
import type { RendererContentContextMenu } from '@/lib/contentContextMenu'
import { useAvatarIdentity } from '@/lib/avatarIdentity'
import { readIdentityDirectoryBridge } from '@/lib/identityDirectoryBridge'
import { useShownAgentName } from '@/hooks/useShownAgentName'
import type { ContentMenuItem } from '@/session/shared/content-context-menu'
import { Avatar } from './Avatar'
import { Menu, MenuItem, MenuSearch, MenuSeparator, MenuSubmenu, useMenuSearch } from './ui/Menu'
import { useMobileShell } from '../hooks/useMobileShell'
import { SelectedTextMenu } from './SelectedTextMenu'

type Row = Exclude<ContentMenuItem, { type: 'separator' }>

/** The same content-menu presentation for host actions and mobile file actions. */
export function ContentMenu({ menu, onClose, onAction }: {
  menu: RendererContentContextMenu
  onClose: () => void
  onAction: (id: string) => void
}) {
  const mobile = useMobileShell()
  const copy = menu.items.find(item => item.type !== 'separator' && item.id === 'copy')
  if (menu.selectionRange && copy && copy.type !== 'separator') {
    return <SelectedTextMenu range={menu.selectionRange} item={copy} onClose={onClose} onCopy={() => onAction(copy.id)} />
  }
  return <Menu x={menu.x} y={menu.y} onClose={onClose}>
    {mobile ? <PhoneRows items={menu.items} onAction={onAction} /> : <Rows items={menu.items} onAction={onAction} />}
  </Menu>
}

type RowsProps = { items: readonly ContentMenuItem[]; onAction: (id: string) => void }

// A search matches what a row shows: a member by the name the identity directory gives them (PersonRow's), not the App's label.
const labelOf = (row: ContentMenuItem) => row.type === 'separator' ? ''
  : row.person ? readIdentityDirectoryBridge()?.getSnapshot()?.[row.person]?.display_name ?? row.label : row.label

function useRowSearch(rows: readonly ContentMenuItem[]) {
  const { t } = useTranslation('common')
  return useMenuSearch(rows, labelOf, { placeholder: t('menu.search'), noResults: t('menu.noResults') })
}

function Rows({ items, onAction, onOpen }: RowsProps & { onOpen?: (row: Row) => void }) {
  // Icons are all or none in one list: a row without one keeps the empty slot, so every label starts on one edge (「Any」 over members).
  const slot = items.some(item => item.type !== 'separator' && (item.person || item.icon)) ? <span aria-hidden /> : undefined
  const iconOf = (item: Row) => item.icon === 'quote' ? <Reply /> : item.icon === 'file' ? <FileText /> : slot
  return <>{items.map((item, index) => item.type === 'separator' ? <MenuSeparator key={index} />
    : item.items ? onOpen ? <MenuItem key={item.id} icon={iconOf(item)} submenu closeOnClick={false} onClick={() => onOpen(item)}>{item.label}</MenuItem>
      : <Submenu key={item.id} item={item} icon={iconOf(item)} onAction={onAction} />
      : item.person ? <PersonRow key={item.id} item={item} onAction={onAction} />
        : <MenuItem key={item.id} disabled={item.enabled === false} icon={iconOf(item)} danger={item.danger} title={item.title}
          checked={item.checked} shortcut={item.hotkey ? formatHotkeyText(item.hotkey) : undefined}
          onClick={() => onAction(item.id)}>{item.label}</MenuItem>)}</>
}

function Submenu({ item, icon, onAction }: { item: Row; icon: ReactNode; onAction: (id: string) => void }) {
  const { search, shown } = useRowSearch(item.items!)
  return <MenuSubmenu icon={icon} label={item.label} search={search}><Rows items={shown} onAction={onAction} /></MenuSubmenu>
}

/** A phone has no room for a second layer beside the first: a nested row opens in the menu's place, a back row on top. */
function PhoneRows({ items, onAction }: RowsProps) {
  const [trail, setTrail] = useState<Row[]>([])
  const at = trail.at(-1)
  return <PhoneLevel key={at?.id ?? ''} items={at ? at.items! : items} onAction={onAction} onOpen={row => setTrail([...trail, row])}
    back={at && { label: at.label, go: () => setTrail(trail.slice(0, -1)) }} />
}

// Only an opened submenu is searched, as on the desktop: a menu's own first level is never a long list of choices.
function PhoneLevel({ items, onAction, onOpen, back }: RowsProps & { onOpen: (row: Row) => void; back?: { label: string; go: () => void } }) {
  const { search, shown } = useRowSearch(items)
  return <>
    {back && <><MenuItem icon={<ChevronLeft size={16} />} closeOnClick={false} onClick={back.go}>{back.label}</MenuItem><MenuSeparator /></>}
    {back && search && <MenuSearch {...search} className="top-[-4px] -mx-1 mb-1" />}
    <Rows items={back ? shown : items} onAction={onAction} onOpen={onOpen} />
  </>
}

/** A member as everywhere else: avatar and the shown name from the host's identity directory. */
function PersonRow({ item, onAction }: { item: Row; onAction: (id: string) => void }) {
  const id = item.person!
  const identity = useAvatarIdentity(id)
  const name = useShownAgentName({ name: identity?.display_name ?? item.label.trim(), createdAt: identity?.type === 'agent' ? identity.created_at ?? undefined : undefined, id })
  return <MenuItem checked={item.checked} disabled={item.enabled === false} title={item.title} onClick={() => onAction(item.id)}
    icon={<Avatar name={name} avatarUrl={identity?.avatar} seed={id} size={20} isAgent={identity ? identity.type === 'agent' : undefined} harnessBadge={false} still />}>
    {name}
  </MenuItem>
}
