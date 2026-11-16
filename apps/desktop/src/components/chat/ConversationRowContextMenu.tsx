import { Menu } from '../ui/Menu'
import { MenuTableItems } from '../MenuTableItems'
import { conversationMenu, type ConversationMenuEntry, type ConversationRowAction, type ConversationRowMenuState } from '../../session/shared/conversation-row-menu'

/** A conversation's menu at the pointer (or the long-pressed row): the conversation table, minus what `entry` leaves out. */
export function ConversationRowContextMenu({ x, y, entry, state, run, onClose, loadError }: {
  x: number
  y: number
  entry: ConversationMenuEntry
  loadError?: string | null
  state: ConversationRowMenuState
  /** What this entry can run; the table throws if it offers an action this lacks and the entry does not exclude. */
  run: Partial<Record<ConversationRowAction, () => void>>
  onClose: () => void
}) {
  const items = conversationMenu(entry, state, new Set(Object.keys(run) as ConversationRowAction[]))
  return <Menu x={x} y={y} minWidth={160} onClose={onClose}>
    {loadError ? <p role="alert" className="px-3 py-2 text-sm text-[var(--danger-fg)]">{loadError}</p> : null}
    <MenuTableItems items={items} testIdPrefix="conversation-row" onAction={(id) => { onClose(); run[id]!() }} />
  </Menu>
}
