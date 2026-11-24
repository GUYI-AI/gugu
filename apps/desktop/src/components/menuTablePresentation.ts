import { Archive, BellOff, CheckCircle, Copy, ExternalLink, EyeOff, GitFork, History, LogOut, MailUnread, MessageCircle, PanelLeft, PanelLeftClose, Pencil, PenLine, Pin, PinOff, RotateCcw, Trash } from '@/lib/icons'
import { i18n } from '@/i18n'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import type { MenuIcon, MenuLabel } from '../session/shared/menu-table'

const ICONS = {
  read: CheckCircle, unread: MailUnread, pin: Pin, unpin: PinOff, sidebar: PanelLeft, 'sidebar-off': PanelLeftClose, rename: Pencil,
  bell: BellOff, archive: Archive, fork: GitFork, copy: Copy, reload: RotateCcw, history: History, trash: Trash, chat: MessageCircle,
  alias: PenLine, leave: LogOut, hide: EyeOff, window: ExternalLink,
} satisfies Record<MenuIcon, unknown>

/** A menu-table icon (the tab menu takes the component). */
export const menuTableIcon = (icon: MenuIcon) => ICONS[icon]

/** A menu-table label in its own catalog. */
export function menuTableLabel(label: MenuLabel): string {
  return label.ns === 'session' ? translateSessionMessage(label.key) : i18n.t(label.key, { ns: label.ns })
}
