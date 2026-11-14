import { useTranslation } from 'react-i18next'
import { BellOff, CheckCircle, Eye, MoreHorizontal, PanelLeftClose, Pin, Trash } from '@/lib/icons'
import { Menu, MenuFold, MenuItem, MenuSeparator } from '../ui/Menu'
import { conversationRowMenu, type ConversationRowAction, type ConversationRowMenuState } from '../../session/shared/conversation-row-menu'

function HideIcon({ size }: { size: number }) {
  return <span aria-hidden className="relative inline-flex">
    <Eye size={size} />
    <span className="pointer-events-none absolute inset-x-0 top-1/2 -rotate-45 border-t-[1.5px] border-current" />
  </span>
}

const icons = { read: CheckCircle, pin: Pin, sidebar: PanelLeftClose, notifications: BellOff, hide: HideIcon, trash: Trash }

export function ConversationRowContextMenu({ x, y, state, onClose, onAction, loadError }: {
  x: number
  y: number
  loadError?: string | null
  state: ConversationRowMenuState
  onClose: () => void
  onAction: (action: ConversationRowAction) => void
}) {
  const { t } = useTranslation('messaging')
  const items = conversationRowMenu(state)
  const row = (item: (typeof items)[number]) => {
    const Icon = icons[item.icon]
    return <MenuItem key={item.id} icon={<Icon size={15} />} danger={item.danger} disabled={item.disabled}
      data-testid={item.id === 'mark-all-read' ? 'chat-row-mark-all-read' : `conversation-row-${item.id}`}
      onClick={() => { onClose(); onAction(item.id) }}>
      {t(`chatList.${item.label}`)}
    </MenuItem>
  }
  return <Menu x={x} y={y} minWidth={160} onClose={onClose}>
    {loadError ? <p role="alert" className="px-3 py-2 text-sm text-[var(--danger-fg)]">{loadError}</p> : null}
    {items.filter((item) => !item.fold && item.id !== 'delete-chat').map(row)}
    {items.some((item) => item.fold) ? <MenuFold icon={<MoreHorizontal size={15} />} label={t('message.actions.more')} data-testid="conversation-row-more">{items.filter((item) => item.fold).map(row)}</MenuFold> : null}
    {items.some((item) => !item.fold && item.id === 'delete-chat') ? <MenuSeparator /> : null}
    {items.filter((item) => !item.fold && item.id === 'delete-chat').map(row)}
  </Menu>
}
